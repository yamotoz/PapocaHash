use argon2::{Algorithm, Argon2, Block, Params, Version};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use md5::{Digest, Md5};
use memmap2::Mmap;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::Sha512;
use std::{
    fs::File,
    io::{self, BufRead, Write},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering::Relaxed},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};
mod cpu;
mod kernel;

// Cada contador ocupa sua linha de cache, evitando disputa entre núcleos.
#[repr(align(64))]
struct Counter(AtomicU64, AtomicUsize);

#[derive(Deserialize)]
struct Request {
    text: String,
    index: String,
    count: usize,
    algorithm: String,
    target: String,
    workers: usize,
    block_size: usize,
    timeout: Option<f64>,
}
#[derive(Serialize)]
struct ResultData {
    status: &'static str,
    attempts: u64,
    elapsed: f64,
    match_seconds: Option<f64>,
    cpu_seconds: Option<f64>,
    setup_seconds: f64,
    word: Option<String>,
    position: Option<usize>,
    stop_latency: Option<f64>,
}
enum Target {
    Md5(Vec<u8>),
    Sha512(Vec<u8>),
    Bcrypt(String),
    Argon(Vec<u8>, Vec<u8>),
}

fn emit(value: &impl Serialize) {
    println!("{}", serde_json::to_string(value).unwrap());
    let _ = io::stdout().flush();
}
fn hex(value: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    if value.len() % 2 != 0 || !value.is_ascii() {
        return Err("Hexadecimal inválido".into());
    }
    (0..value.len()).step_by(2).map(|i| Ok(u8::from_str_radix(&value[i..i + 2], 16)?)).collect()
}
fn target(request: &Request) -> Result<Target, Box<dyn std::error::Error>> {
    Ok(match request.algorithm.as_str() {
        "md5" => Target::Md5(hex(&request.target)?),
        "sha512" => Target::Sha512(hex(&request.target)?),
        "bcrypt" => Target::Bcrypt(request.target.clone()),
        "argon2id" => {
            let pieces: Vec<_> = request.target.split('$').collect();
            if pieces.len() != 6 || pieces[3] != "m=8192,t=2,p=1" {
                return Err("Parâmetros Argon2id inválidos".into());
            }
            Target::Argon(STANDARD_NO_PAD.decode(pieces[4])?, STANDARD_NO_PAD.decode(pieces[5])?)
        }
        _ => return Err("Algoritmo desconhecido".into()),
    })
}

struct Search<'a> {
    request: &'a Request,
    text: &'a [u8],
    offsets: &'a [u8],
    next: &'a AtomicUsize,
    stop: &'a AtomicBool,
    counters: &'a [Counter],
    started: Instant,
    matched: &'a std::sync::Mutex<Option<(String, usize, f64)>>,
}

impl Search<'_> {
    fn scan<F: FnMut(&[u8]) -> bool>(&self, worker: usize, interval: u64, mut verify: F) {
        let offset = |i: usize| u64::from_le_bytes(self.offsets[i * 8..i * 8 + 8].try_into().unwrap()) as usize;
        let counter = &self.counters[worker].0;
        let mut attempts = 0;
        while !self.stop.load(Relaxed) {
            let begin = self.next.fetch_add(self.request.block_size, Relaxed);
            if begin >= self.request.count {
                break;
            }
            let end = (begin + self.request.block_size).min(self.request.count);
            let block_start = attempts;
            let found = kernel::find(&self.text[offset(begin)..offset(end)], |word| {
                if attempts % interval == 0 {
                    counter.store(attempts, Relaxed);
                    if self.stop.load(Relaxed) {
                        return true;
                    }
                    self.counters[worker].1.store(begin + (attempts - block_start) as usize + 1, Relaxed);
                }
                attempts += 1;
                verify(word)
            });
            counter.store(attempts, Relaxed);
            if attempts > block_start {
                self.counters[worker].1.store(begin + (attempts - block_start) as usize, Relaxed);
            }
            if let Some(index) = found {
                // Um cancelamento também encerra o iterator, mas não publica palavra.
                if self.stop.load(Relaxed) {
                    break;
                }
                let start = offset(begin + index);
                let finish = offset(begin + index + 1) - 1;
                let mut result = self.matched.lock().unwrap();
                if result.is_none() {
                    *result = Some((
                        String::from_utf8_lossy(&self.text[start..finish]).into_owned(),
                        begin + index + 1,
                        self.started.elapsed().as_secs_f64(),
                    ));
                }
                self.stop.store(true, Relaxed);
                break;
            }
        }
        counter.store(attempts, Relaxed);
    }
}

fn run(request: Request) -> Result<(), Box<dyn std::error::Error>> {
    if request.workers == 0 || request.block_size == 0 || request.count == 0 {
        return Err("Trabalhadores, bloco e lista devem ser positivos".into());
    }
    let setup = Instant::now();
    let text_file = File::open(&request.text)?;
    let index_file = File::open(&request.index)?;
    // Arquivos de snapshot permanecem imutáveis durante todo o mmap.
    let text = unsafe { Mmap::map(&text_file)? };
    let offsets = unsafe { Mmap::map(&index_file)? };
    if offsets.len() != (request.count + 1) * 8 {
        return Err("Índice incompatível com a wordlist".into());
    }
    let target = target(&request)?;
    let pool = rayon::ThreadPoolBuilder::new().num_threads(request.workers).build()?;
    let stop = Arc::new(AtomicBool::new(false));
    let next = AtomicUsize::new(0);
    let counters: Vec<_> = (0..request.workers).map(|_| Counter(AtomicU64::new(0), AtomicUsize::new(0))).collect();
    let external = stop.clone();
    let input = Arc::new(AtomicBool::new(false));
    let input_flag = input.clone();
    thread::spawn(move || {
        let mut line = String::new();
        if io::stdin().lock().read_line(&mut line).is_ok() && line.trim() == "cancel" {
            input_flag.store(true, Relaxed);
            external.store(true, Relaxed);
        }
    });
    let started = Instant::now();
    let cpu_started = cpu::seconds();
    emit(&serde_json::json!({"type":"started", "setup_seconds":setup.elapsed().as_secs_f64()}));
    let total = || counters.iter().map(|n| n.0.load(Relaxed)).sum::<u64>();
    let finished = AtomicBool::new(false);
    let timed_out = AtomicBool::new(false);
    let stop_time = std::sync::Mutex::new(None::<Instant>);
    let matched = std::sync::Mutex::new(None::<(String, usize, f64)>);
    let search = Search {
        request: &request,
        text: &text,
        offsets: &offsets,
        next: &next,
        stop: &stop,
        counters: &counters,
        started,
        matched: &matched,
    };
    let mut search_elapsed = 0.0;
    thread::scope(|scope| {
        let monitor = scope.spawn(|| {
            while !finished.load(Relaxed) {
                let elapsed = started.elapsed().as_secs_f64();
                if request.timeout.is_some_and(|limit| elapsed >= limit) && !stop.load(Relaxed) {
                    timed_out.store(true, Relaxed);
                    stop.store(true, Relaxed);
                    *stop_time.lock().unwrap() = Some(Instant::now());
                }
                let positions: Vec<_> = counters.iter().take(16).map(|counter| counter.1.load(Relaxed)).collect();
                emit(&serde_json::json!({"type":"progress", "attempts":total(), "elapsed":elapsed, "candidate_positions":positions}));
                let interval = request.timeout.map_or(0.1, |limit| (limit - elapsed).clamp(0.001, 0.1));
                thread::park_timeout(Duration::from_secs_f64(interval));
            }
        });
        // Selecionar fora do laço especializa cada hash em tempo de compilação.
        pool.install(|| {
            (0..request.workers).into_par_iter().for_each(|worker| match &target {
                Target::Md5(expected) => search.scan(worker, 256, |word| Md5::digest(word).as_slice() == expected),
                Target::Sha512(expected) => {
                    search.scan(worker, 256, |word| Sha512::digest(word).as_slice() == expected)
                }
                Target::Bcrypt(expected) => {
                    search.scan(worker, 1, |word| bcrypt::verify(word, expected).unwrap_or(false))
                }
                Target::Argon(salt, expected) => {
                    let argon =
                        Argon2::new(Algorithm::Argon2id, Version::V0x13, Params::new(8192, 2, 1, Some(32)).unwrap());
                    // Uma alocação por trabalhador, reutilizada em todas as tentativas.
                    let mut memory = vec![Block::default(); 8192];
                    let mut output = [0u8; 32];
                    search.scan(worker, 1, |word| {
                        argon.hash_password_into_with_memory(word, salt, &mut output, &mut memory).is_ok()
                            && output.as_slice() == expected
                    });
                }
            })
        });
        search_elapsed = started.elapsed().as_secs_f64();
        finished.store(true, Relaxed);
        monitor.thread().unpark();
    });
    let found = matched.into_inner().unwrap();
    let elapsed = search_elapsed;
    let status = if found.is_some() {
        "found"
    } else if input.load(Relaxed) {
        "cancelled"
    } else if timed_out.load(Relaxed) {
        "timeout"
    } else {
        "exhausted"
    };
    let result = ResultData {
        status,
        attempts: total(),
        elapsed,
        match_seconds: found.as_ref().map(|value| value.2),
        cpu_seconds: cpu::seconds().zip(cpu_started).map(|(end, start)| end - start),
        setup_seconds: started.duration_since(setup).as_secs_f64(),
        word: found.as_ref().map(|v| v.0.clone()),
        position: found.map(|v| v.1),
        stop_latency: stop_time.into_inner().unwrap().map(|t| t.elapsed().as_secs_f64()),
    };
    let positions: Vec<_> = counters.iter().take(16).map(|counter| counter.1.load(Relaxed)).collect();
    emit(&serde_json::json!({"type":"result", "result":result, "candidate_positions":positions}));
    Ok(())
}

fn main() {
    let parsed = (|| -> Result<Request, Box<dyn std::error::Error>> {
        let mut line = String::new();
        io::stdin().lock().read_line(&mut line)?;
        Ok(serde_json::from_str(&line)?)
    })();
    if let Err(error) = parsed.and_then(run) {
        emit(&serde_json::json!({"type":"error", "message":error.to_string()}));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn known_digests() {
        assert_eq!(Md5::digest(b"abc").as_slice(), hex("900150983cd24fb0d6963f7d28e17f72").unwrap());
        assert_eq!(Sha512::digest(b"abc").len(), 64);
    }
    #[test]
    fn argon_memory_reuse() {
        let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, Params::new(8192, 2, 1, Some(32)).unwrap());
        let mut memory = vec![Block::default(); 8192];
        let (mut a, mut b) = ([0; 32], [0; 32]);
        argon.hash_password_into_with_memory(b"abc", b"0123456789abcdef", &mut a, &mut memory).unwrap();
        argon.hash_password_into_with_memory(b"abc", b"0123456789abcdef", &mut b, &mut memory).unwrap();
        assert_eq!(a, b);
    }
}
