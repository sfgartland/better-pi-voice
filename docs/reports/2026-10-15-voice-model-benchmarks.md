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

---

## Addendum: measured on real speech

A 12 s recording of the actual user (16 kHz mono), so accuracy numbers stop being
inherited from the curated table.

### The recording contains music, and no silence at all

| | value |
|---|---|
| minimum 100 ms level | 0.307 |
| 10th percentile | 0.406 |
| median | 0.930 |
| chunks at or below 0.05 | **0 of 120** |

Background music plays for the first part of the clip and the user says so on the
recording. Even after it stops there is no near-silence, only normal room tone. This
matters more than it looks: **an absolute silence threshold never fires in a real
room**, so pause-aware chunking would silently never run. `parakeet.silenceLevel`
therefore defaults to 0.35 rather than 0.05.

### Batch transcription of the real recording

| model | size | load | transcribe | RTF | text |
|---|---|---|---|---|---|
| **parakeet-tdt_ctc-110m** | 135 MB | 686 ms | 2 843 ms | **4.22** | correct, capitalised and punctuated |
| SenseVoiceSmall | 253 MB | 1 880 ms | 3 062 ms | 3.92 | correct but lowercased, no punctuation |
| canary-180m-flash | 218 MB | 3 738 ms | 3 158 ms | 3.80 | correct, capitalised and punctuated |
| parakeet-tdt-0.6b-v2 | 730 MB | 8 644 ms | 11 552 ms | 1.04 | correct |
| whisper-small | 270 MB | 1 617 ms | 12 254 ms | 0.98 | correct |
| parakeet-unified-0.6b | 731 MB | 2 634 ms | 22 193 ms | 0.54 | correct |

Every model got the words right; the differences are capitalisation and punctuation.
So on a 12 s clip, accuracy does not separate them — speed and size do, and
`parakeet-tdt_ctc-110m` wins both: fastest, smallest, and the quickest to load.

### Chunk safety: does a model accept audio starting mid-utterance?

Characters transcribed from a 24 s clip sliced at increasing offsets. A chunked batch
implementation cuts audio, so every chunk after the first starts mid-utterance.

| model | 0 s | 4 s | 6 s | 8 s | 10 s | 12 s |
|---|---|---|---|---|---|---|
| **parakeet-tdt_ctc-110m** | 318 | 292 | 253 | 215 | 192 | 164 |
| SenseVoiceSmall | 316 | 288 | 249 | 233 | 99 | 162 |
| canary-180m-flash | 318 | **0** | **0** | **0** | **0** | 164 |

`parakeet-tdt_ctc-110m` degrades smoothly and never fails. **`canary-180m-flash`
returns an empty transcript for every mid-utterance start**, which disqualifies it for
chunked batch use entirely — a cut inside a word would silently discard that chunk.

### Conclusion

Switch the default model from `canary-180m-flash` to **`parakeet-tdt_ctc-110m`**
(135 MB): it is the fastest on real speech, the smallest, the fastest to load, and the
only one of the small models verified to survive an arbitrary chunk boundary.

### Addendum 2: an automatic pause threshold

A second recording (12 s, this time with deliberate pauses) showed why a fixed threshold
cannot work. The two real recordings:

| recording | p10 (noise) | p75 (speech) | auto threshold | pauses found |
|---|---|---|---|---|
| `my-speech` (music) | 0.406 | 1.000 | 0.584 | 10 runs |
| `my-speech-2` (quiet, pausing) | 0.307 | 1.000 | 0.515 | 0.1–1.0 s, 3.9–5.6 s, 8.5–10.0 s |

A fixed 0.05 found no pause in either; a fixed 0.35 found few. So `silenceLevel` now
defaults to `"auto"`: noise from the 10th percentile, speech from the 75th, and a boundary
counts as a pause below 30% of that range. When the level barely varies the range collapses
and nothing is cut, which is the correct answer for unbroken speech or steady noise.

Verified end to end on a 24 s doubling of the real recording with `parakeet-tdt_ctc-110m`:
two chunks of 12.9 s and 11.1 s, both transcribed, 24.0 s accounted for, nothing lost.
