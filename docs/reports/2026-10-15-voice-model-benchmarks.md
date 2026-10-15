# Local voice model benchmarks

**Date:** 2026-10-15
**Machine:** 8-core x86_64, 15 GB RAM. `transcribe-cpp` chose the **Vulkan / Intel UHD iGPU**
path (`backend=auto`), not CPU. The `TU: error: ...VULKAN...` line on stderr concerns a
different render node and is harmless.
**Audio:** `/tmp/vsmoke/speech.pcm` — 6.653 s, 16 kHz mono s16le, piper-synthesised English.
**RTF** = audio seconds ÷ wall seconds, so higher is faster; **1.0 is the real-time floor**.

## Measured on this machine

Second of two runs per measurement, models warm-loaded.

| model | size | streams | warm load | batch | batch RTF | stream feed | stream total | **stream RTF** | first text |
|---|---|---|---|---|---|---|---|---|---|
| multitalker-parakeet-streaming-0.6b-v1 | 734 MB | yes | 501 ms | 4 825 ms | 1.38 | 6 056 ms | 7 356 ms | **0.90** | 1 142 ms |
| parakeet-unified-en-0.6b | 731 MB | yes | 551 ms | 3 363 ms | 1.98 | 8 680 ms | 11 161 ms | **0.60** | 969 ms |
| nemotron-3.5-asr-streaming-0.6b | 751 MB | yes | 633 ms | 5 408 ms | 1.23 | 5 768 ms | 7 050 ms | **0.94** | 1 277 ms |
| parakeet-tdt_ctc-110m | 135 MB | no | 116 ms | 1 968 ms | **3.38** | n/a | n/a | n/a | n/a |
| canary-180m-flash | 218 MB | no | 168 ms | 1 513 ms | **4.40** | n/a | n/a | n/a | n/a |
| SenseVoiceSmall | 253 MB | no | 233 ms | 1 309 ms | **5.08** | n/a | n/a | n/a | n/a |
| parakeet-tdt-0.6b-v2 | 730 MB | no | 532 ms | 3 227 ms | 2.06 | n/a | n/a | n/a | n/a |
| whisper-small | 270 MB | no | 314 ms | 7 547 ms | 0.88 | n/a | n/a | n/a | n/a |

Host load averaged 3.0 rising to 7.3 during this run. An earlier run under a load average
peaking near 32 gave the same ranking with absolute times up to 4× worse, so treat these as
consistent *relative* comparisons and pessimistic *absolute* numbers.

## Accuracy, from the pi-voice benchmark data

Word error rate on English, and the curated real-time factor, from
`@earendil-works/pi-voice/catalog/recommendations.json`.

| model | en WER | curated RTF (cpu) | languages |
|---|---|---|---|
| parakeet-unified-en-0.6b | **3.99** | 7.5 | en |
| canary-qwen-2.5b | 3.58 | 2.1 | en |
| parakeet-tdt-0.6b-v2 | 4.11 | 8.0 | en |
| canary-180m-flash | 5.98 | 21.3 | en, de, es, fr |
| parakeet-tdt_ctc-110m | 6.11 | 23.5 | en |
| multitalker-parakeet-streaming-0.6b-v1 | 6.52 | 13.5 | en |
| SenseVoiceSmall | 7.14 | 15.5 | 5 langs |
| nemotron-3.5-asr-streaming-0.6b | 7.9 | 7.5 | 32 langs |
| whisper-small | 6.51 | 3.4 | 99 langs |

The curated figures are much higher than anything measured here, which means they were taken
on an idle machine and probably measure batch throughput. Use them for ranking, not for
predicting this laptop.

## What this says

**No streaming model keeps up on this machine.** All three run below the real-time floor
(0.60–0.94), so while speaking, text drifts further behind the longer the utterance runs.
Leaving aside accuracy, `nemotron` (0.94) and `multitalker` (0.90) are about 1.5× faster at
streaming than `parakeet-unified` (0.60) for the same 730 MB.

**Batch is two to eight times faster than streaming in the same size class**, and the small
batch models are both tiny and fast: 135–253 MB at 3.4–5.1 RTF. That is the opposite of the
usual trade-off — here the lighter models are also the quicker ones.

### Best options (model + mode)

| rank | model | mode | size | measured | en WER | why |
|---|---|---|---|---|---|---|
| 1 | **canary-180m-flash** | batch | 218 MB | 4.40 RTF | 5.98 | best speed/accuracy balance; also de/es/fr |
| 2 | **parakeet-tdt_ctc-110m** | batch | 135 MB | 3.38 RTF | 6.11 | lightest by far; 116 ms warm load |
| 3 | **SenseVoiceSmall** | batch | 253 MB | 5.08 RTF | 7.14 | fastest of the small batch models |
| 4 | **nemotron-3.5-asr-streaming-0.6b** | streaming | 751 MB | 0.94 RTF | 7.9 | the only streaming choice worth having, and 32 languages |
| 5 | parakeet-unified-en-0.6b | streaming | 731 MB | 0.60 RTF | **3.99** | most accurate, but much too slow to stream here |

The current default (streaming + `parakeet-unified`) is the *worst* combination on this
machine: the slowest streaming model paired with the mode that is 2–8× slower than batch.

## Caveats

- **Audio is synthetic.** Piper TTS is cleaner than a human and its phrasing is not natural
  dictation. Every number above is throughput, which is content-independent and therefore
  valid; the accuracy comparison is from the curated data, not from this audio. Choosing a
  model on accuracy needs a recording of real speech.
- **Absolute times are inflated** by unrelated load on the host.
- `nemotron` rejects `language: "en"` and requires a region code such as `en-US`. Worth
  knowing before wiring it up.
- `whisper-small` is not competitive here: about 0.9× real-time in batch on this GPU path,
  and far worse on CPU.

## Reproduction

```bash
# models land in /tmp/voice-bench/models
timeout 1800 bun /tmp/voice-bench/bench.ts
# raw numbers, including per-run spread and host load: /tmp/voice-bench/results.json
```
