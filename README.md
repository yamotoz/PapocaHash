<p align="center"><img src="assets/logo.svg" width="76" alt="PapocaHash"></p>

<h1 align="center">PapocaHash</h1>
<p align="center"><em>O desempenho deixa de ser uma hipótese.</em></p>
<p align="center">HTML · CSS · JavaScript · Python · Rust</p>

---

Um laboratório local para preparar uma palavra, gerar quatro hashes e observar buscas reais em **1.000.000 de candidatos distintos**. Três motores, todos os processadores disponíveis por padrão, gráficos ao vivo e resultados exportáveis.

## Comece por aqui

1. Clique em **`server.bat`**. O primeiro preparo precisa de internet: instala Python em ambiente local, obtém dependências e compila o Rust otimizado. O toolchain Rust GNU deve estar instalado; ele já foi identificado neste computador.
2. Abra **`index.html`** com dois cliques. Também é possível acessar `http://127.0.0.1:8765`.
3. Aguarde o balão **Servidor online**, digite a palavra mestra e clique em **Preparar experimento**.
4. Abra um card, selecione o motor e execute. **Comparar os três** executa um motor após o outro, evitando competição entre os testes.

Mantenha a janela do servidor aberta. `Ctrl+C` encerra o serviço e solicita a parada das buscas. A interface se reconecta automaticamente; após reiniciar o servidor, prepare um novo experimento.

O front não exige Node, instalação de pacotes ou build. Scripts clássicos e assets locais permitem a abertura por `file://`. O servidor escuta apenas em `127.0.0.1:8765`.

## Da palavra ao resultado

Cada preparação cria uma wordlist imutável e os quatro hashes da mesma palavra. A posição é sorteada entre **500.000 e 1.000.000**, inclusive, numerada a partir de 1. A inserção substitui uma entrada; quando a palavra já existe, duas posições são trocadas para preservar a unicidade.

Os candidatos sintéticos seguem `papoca0000000` até `papoca0999999`. A lista física base está em `data/base/wordlist1kk.txt`; snapshots de experimentos ficam em `data/<id>/`. Cada arquivo acompanha um índice de offsets de 64 bits. Textos são UTF-8, com uma entrada por linha; palavras mestras aceitam de 1 a 72 bytes, sem quebras de linha ou NUL.

A inserção copia trechos da base em blocos e ajusta os offsets necessários, evitando recriar um milhão de strings a cada palavra. A confirmação só aparece depois de o snapshot estar pronto.

Os motores recebem **apenas a lista e o hash**. A posição conhecida não é usada para pular tentativas. Você pode editar o hash de destino; se nenhum candidato corresponder, a lista será esgotada. Com paralelismo, posição e número de tentativas podem diferir.

| Algoritmo | Parâmetros do laboratório | Verificação |
| --- | --- | --- |
| MD5 | 128 bits | Digest binário |
| SHA-512 | 512 bits | Digest binário |
| bcrypt | Custo 4, salt aleatório | Verificador da biblioteca |
| Argon2id | v19, 8 MiB, duas passagens, uma lane, salt de 16 bytes, resultado de 32 bytes | Digest binário |

Os parâmetros de bcrypt/Argon2id são **didáticos**. O campo de hash manual aceita esses mesmos custos. A ordenação dos tempos é determinada pelas medições: algoritmo, biblioteca, hardware e quantidade de trabalhadores influenciam o resultado.

## Pouco código no núcleo, engenharia ao redor

**Python iterativo**

```python
def iterative(words, check):
    # Enumerar o bloco evita índice/decodificação no caminho crítico.
    for index, word in enumerate(words):
        if check(word):
            return index
    return None
```

**Python recursivo**

```python
def recursive(words, check, lo=0, hi=None):
    hi = len(words) if hi is None else hi
    if lo >= hi:
        return None
    if hi - lo == 1:
        return lo if check(words[lo]) else None
    # Divisão equilibrada: todos os candidatos, pilha O(log bloco).
    mid = (lo + hi) // 2
    found = recursive(words, check, lo, mid)
    return found if found is not None else recursive(words, check, mid, hi)
```

**Rust paralelo — núcleo executado em cada bloco**

```rust
// A closure monomorfizada permite integrar o hash ao laço.
pub fn find<F: FnMut(&[u8]) -> bool>(block: &[u8], verify: F) -> Option<usize> {
    block.split(|&byte| byte == b'\n').filter(|word| !word.is_empty()).position(verify)
}
```

A camada de execução entrega blocos a esses núcleos, contabiliza tentativas, verifica cancelamento e publica resultados. O número de linhas mostrado na UI é calculado a partir do código: conta o núcleo, excluindo comentários e linhas vazias. Bibliotecas e orquestração ficam fora dessa contagem.

- **CPU:** Python usa processos para contornar o GIL nas entradas curtas; Rust usa um pool Rayon. O padrão é um trabalhador por processador lógico — 16 neste computador. [Referência do hashlib](https://docs.python.org/3/library/hashlib.html).
- **Memória:** arquivos mapeados compartilhados; filas transportam configurações, não milhões de strings. Rust trabalha com fatias emprestadas; Python prepara candidatos em bytes por bloco.
- **Balanceamento:** blocos distribuídos dinamicamente em ordem crescente. Defaults de 4.096 candidatos para os digests rápidos e 64 para os hashes lentos.
- **Cache:** contadores separados por 64 bytes reduzem a disputa entre núcleos. Contagens são publicadas em lotes; o total final soma todos os trabalhadores.
- **Rust:** dispatch do algoritmo fora do laço, funções especializadas pelo compilador, buffers Argon2 reutilizados por trabalhador, `release`, LTO, uma unidade de codegen e `target-cpu=native`.
- **Python:** pool reaproveitado entre comparações; mapeamentos e verificadores são preparados antes da barreira que inicia o cronômetro.

A construção dos hashes pertence a `hashlib`, `bcrypt`, `argon2-cffi` e crates criptográficas consolidadas. Python também utiliza implementações nativas dessas bibliotecas; este experimento compara a pilha completa de cada motor.

A busca faz **O(n × H)** de trabalho: `n` candidatos e custo `H` por verificação. Paralelismo distribui esse trabalho; recursão equilibrada usa **O(log b)** de pilha, com `b` sendo o tamanho do bloco. O ganho real é afetado por memória, escalonamento, biblioteca e frequência da CPU.

## Leia as evidências

| Medição | Significado |
| --- | --- |
| Tempo de busca | Da liberação dos trabalhadores até a conclusão do trabalho; polling da interface é separado |
| Até encontrar | Instante do primeiro resultado encontrado, disponível no detalhe da linha e no JSON |
| Preparo / tempo total | Inicialização e duração de ponta a ponta, visíveis no detalhe da linha e no JSON |
| Tentativas/s | Total efetivamente verificado dividido pelo tempo de busca |
| Progresso | Tentativas sobre o tamanho da lista; encontrar a palavra pode encerrar antes de 100% |
| Estimativa | Tempo aproximado para esgotar os candidatos restantes, atualizado pela velocidade observada |
| CPU | Processos da busca, normalizados pela capacidade de todos os processadores lógicos |
| Memória | Soma dos RSS dos processos; páginas compartilhadas podem aparecer em mais de um RSS |
| GPU | Telemetria global via `nvidia-smi`; inclui outras aplicações. A busca executa na CPU |
| Timeout | Prazo de busca; não prova ausência da palavra na lista |
| Latência de parada | Tempo entre solicitar interrupção e recolher o trabalho |

O gráfico usa candidatos no eixo horizontal e tempo no vertical. As amostras vêm do motor; animações afetam o desenho. Buscas muito rápidas podem ter só os pontos inicial e final. Uma medição de CPU sem amostras suficientes aparece indisponível na tabela.

O indicador compacto **Busca em curso**, no canto do gráfico, exibe uma seleção real de candidatos processados pelos trabalhadores. As palavras trocam em rajadas a cada 24 ms enquanto há amostras disponíveis; a palavra confirmada se estabiliza em verde. Até 16 trabalhadores fornecem amostras por atualização; não é uma transmissão de todas as tentativas. Detalhes ficam no “i”. O desenho do gráfico interpola a partir do estado atual entre atualizações, preservando as amostras reais nos detalhes e na exportação. Tempos na interface usam **uma casa decimal em segundos**; o JSON mantém a precisão completa.

A vitrine **A engenharia por trás da descoberta** apresenta os dois núcleos Python e o núcleo Rust reais, com resumos, realce de sintaxe e cópia do código. O resumo Rust distingue a busca por fatias dentro do bloco do paralelismo Rayon entre blocos. A entrada dos cards acompanha a rolagem. Animações respeitam a preferência de movimento reduzido do navegador.

Comparações de uma execução não substituem benchmarks repetidos. A ordem dos blocos concorrentes e a temperatura do computador podem alterar tempos e tentativas. Os resultados do experimento permanecem no overview; **Exportar JSON** salva amostras, parâmetros e métricas. O servidor também grava resultados em `data/results/`.

## Testes e benchmarks

Depois de preparar o ambiente:

```powershell
# Casos de integração, motores, Unicode, entradas inválidas e interrupções.
.venv\Scripts\python.exe -m pytest -q -m "not full"

# Bateria completa, incluindo 12 buscas na lista de um milhão.
.\test-all.bat

# Testes Rust, incluindo buffers Argon2 reutilizados.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/rust.ps1 -Action test

# Escalabilidade: 1, 2, 4, 8 e 16 trabalhadores disponíveis, três repetições.
.venv\Scripts\python.exe -m scripts.benchmark --algorithm md5

# Variação de blocos e avaliação do custo de telemetria.
.venv\Scripts\python.exe -m scripts.benchmark --algorithm md5 --tune-blocks
.venv\Scripts\python.exe -m scripts.benchmark --algorithm md5 --no-telemetry

# Hashes lentos: começar com uma carga menor para medir escalabilidade.
.venv\Scripts\python.exe -m scripts.benchmark --algorithm argon2id --count 10000
```

Benchmarks usam um alvo ausente para verificar exatamente a mesma quantidade de candidatos. Relatórios com mediana e dispersão ficam em `data/benchmarks/`. As buscas integrais dos hashes lentos podem levar bastante tempo.

Para validar o front com Node e Playwright, opcionais para desenvolvimento:

```powershell
npm install
npx playwright install chromium
npm test
npm run test:ui
```

`npm test` verifica arquivos e a wordlist física. Os testes de navegador usam uma API com **fixtures explícitas** para validar interações; não constituem benchmarks ou validação criptográfica.

### Verificações realizadas nesta entrega

- **Passou:** testes estáticos da interface; abertura real por `file://`; conexão/desconexão; preparo e comparação com fixtures; validação de trabalhadores; cancelamento e timeout; layouts de 1440 e 390 pixels sem overflow.
- **Passou após a correção dos balões:** todos os informativos da página e dos quatro modais em seis tamanhos de tela (320, 390, 768, 844, 1024 e 1440 pixels). Verificações de limites da tela, camada visível, tags sem sobreposição, navegação pelo teclado e clique nos “i” sem alterar o motor selecionado.
- **Passou:** compilação independente do núcleo Rust, testes de limites/Unicode, parada no primeiro resultado e travessia de exatamente 1.000.000 de candidatos.
- **Passou:** compilação e teste independente da leitura nativa de tempo de CPU do processo pelo Windows (`GetProcessTimes`).
- **Passou:** geração física da lista base e verificação de 1.000.000 de entradas distintas, arquivo de 14.000.000 bytes e índice de 8.000.008 bytes.
- **Passou após a correção do preparo GNU:** compilação completa em `release`; seis testes Rust; 72 testes Python de integração com os quatro hashes nos três motores, ausência, Unicode, cancelamento, timeout e amostras reais de candidatos; nove testes adicionais de snapshots e buscas MD5/SHA-512 na lista de um milhão.
- **Passou:** animação de candidatos nos estados de busca, descoberta e interrupção; avanço contínuo do gráfico entre amostras; segundos com uma casa decimal; código da vitrine idêntico a `backend/kernels.py`; preferência de movimento reduzido. Testes de navegador usam fixtures explícitas.
- **Passou:** inicialização real do servidor e resposta de saúde em `http://127.0.0.1:8765/api/health`.
- **Pendente de execução:** as seis buscas integrais de bcrypt/Argon2id na lista de um milhão. Esses hashes passaram nos testes de integração com listas menores; os testes integrais permanecem disponíveis em `test-all.bat`.

Dependências diretas têm versões fixadas. Os arquivos `uv.lock` e `rust-engine/Cargo.lock` já foram gerados; o preparo usa os locks para manter as versões resolvidas.

## Organização

```text
index.html              Interface sem build
assets/                 Identidade SVG, CSS e JavaScript
backend/                API, snapshots, métricas e motores Python
rust-engine/            Motor Rust e protocolo NDJSON
scripts/                Preparo do ambiente e benchmarks
tests/                  Contratos da UI, integração e testes integrais
data/                   Wordlists, índices e resultados locais
server.bat              Primeiro preparo + servidor
test-all.bat            Bateria completa
```

API: `GET /api/health`, `GET /api/catalog`, `POST /api/experiments`, `POST /api/jobs`, `GET /api/jobs/{id}` e `POST /api/jobs/{id}/cancel`. A fila executa uma busca por vez. `timeout` é opcional; `block_size` pode ser informado nos benchmarks/API. Os arquivos de trabalho permanecem dentro do projeto.

## Se algo impedir o início

- **Download falhou:** confira a internet e execute `server.bat` novamente; o preparo é reaproveitado.
- **Rust não encontrado:** instale o toolchain `stable-x86_64-pc-windows-gnu` pelo rustup.
- **`dlltool.exe` não encontrado:** a configuração GNU usa agora o backend oficial `windows_legacy` de `getrandom`, com o gerador nativo do Windows via `advapi32`. Isso evita gerar imports que exigem `dlltool` e um assembler externo. Execute `server.bat` novamente; não é necessário instalar MinGW adicional. [Documentação de getrandom](https://docs.rs/getrandom/0.3.4/getrandom/).
- **Porta 8765 ocupada:** encerre a outra instância do PapocaHash ou o serviço que esteja usando essa porta.
- **GPU indisponível:** as buscas continuam pela CPU; a UI informa a ausência da telemetria.
- **Novo computador:** recompile o Rust, pois `target-cpu=native` usa os recursos do processador da máquina de compilação.

A identidade visual está descrita em [BRAND.md](BRAND.md). Logo, favicon e artes dos cards são vetores próprios, criados diretamente no projeto.
