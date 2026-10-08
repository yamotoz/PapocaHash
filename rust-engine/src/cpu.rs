/// CPU de todo o processo, incluindo as threads Rayon. FILETIME usa 100 ns.
#[cfg(windows)]
pub fn seconds() -> Option<f64> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> *mut std::ffi::c_void;
        fn GetProcessTimes(
            process: *mut std::ffi::c_void,
            creation: *mut u64,
            exit: *mut u64,
            kernel: *mut u64,
            user: *mut u64,
        ) -> i32;
    }
    let (mut creation, mut exit, mut kernel, mut user) = (0, 0, 0, 0);
    // O próprio processo fornece o handle; os quatro buffers têm oito bytes.
    let ok = unsafe { GetProcessTimes(GetCurrentProcess(), &mut creation, &mut exit, &mut kernel, &mut user) };
    (ok != 0).then_some((kernel + user) as f64 / 10_000_000.0)
}

#[cfg(not(windows))]
pub fn seconds() -> Option<f64> {
    None
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn process_cpu_clock_is_available_and_monotonic() {
        let before = super::seconds().expect("GetProcessTimes deve ler o próprio processo");
        for i in 0..1_000_000u64 {
            std::hint::black_box(i.wrapping_mul(17));
        }
        let after = super::seconds().unwrap();
        assert!(after >= before);
    }
}
