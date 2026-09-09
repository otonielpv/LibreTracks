Release render comparison — 12th Gen Intel(R) Core(TM) i7-12700KF

3 repetitions of 256 measured blocks per case. Values are medians across runs; p99 is not a pooled percentile.

Resident synthetic PCM, paced callbacks. No audio device, streaming disk workload or GUI. The director uses normal thread priority; workers use engine priority promotion. Do not extrapolate these results to other hardware or interpret late renders as measured driver xruns.

| Case | Buffer | Threads | p95 before → after (µs) | Change | p99 before → after (µs) | Late blocks before → after | Process CPU before → after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| warp-small | 128 | 1 | 537.0 → 566.6 | 5.5% | 648.2 → 724.0 | 0 → 0 | 0.343% → 0.343% |
| warp-small | 128 | 2 | 525.2 → 561.7 | 6.9% | 654.1 → 753.6 | 0 → 0 | 0.343% → 0.343% |
| warp-small | 128 | 4 | 492.4 → 545.7 | 10.8% | 573.4 → 700.8 | 0 → 0 | 0.458% → 0.229% |
| warp-small | 512 | 1 | 1192.3 → 1166.5 | -2.2% | 1328.2 → 1310.8 | 0 → 0 | 0.372% → 0.343% |
| warp-small | 512 | 2 | 1213.3 → 1222.0 | 0.7% | 1435.2 → 1483.5 | 0 → 0 | 0.315% → 0.400% |
| warp-small | 512 | 4 | 1173.8 → 1299.7 | 10.7% | 1359.7 → 1507.6 | 0 → 0 | 0.372% → 0.515% |
| warp | 128 | 1 | 1714.3 → 1711.5 | -0.2% | 1883.0 → 1885.5 | 1 → 0 | 1.601% → 1.486% |
| warp | 128 | 2 | 962.6 → 972.6 | 1.0% | 1056.5 → 1090.4 | 0 → 0 | 1.487% → 1.830% |
| warp | 128 | 4 | 645.0 → 612.9 | -5.0% | 707.6 → 654.0 | 0 → 0 | 1.372% → 1.829% |
| warp | 512 | 1 | 3743.2 → 3694.5 | -1.3% | 4158.6 → 3961.4 | 0 → 0 | 1.459% → 1.487% |
| warp | 512 | 2 | 2266.2 → 2039.5 | -10.0% | 2467.1 → 2426.2 | 0 → 0 | 1.659% → 1.716% |
| warp | 512 | 4 | 1729.4 → 1811.9 | 4.8% | 2219.1 → 2333.8 | 0 → 0 | 1.945% → 2.231% |
| muted | 128 | 1 | 103.1 → 118.4 | 14.8% | 180.2 → 172.4 | 0 → 0 | 0.114% → 0.000% |
| muted | 128 | 2 | 99.7 → 86.1 | -13.6% | 163.5 → 144.0 | 0 → 0 | 0.114% → 0.114% |
| muted | 128 | 4 | 122.6 → 111.6 | -9.0% | 182.5 → 177.1 | 0 → 0 | 0.114% → 0.229% |
| muted | 512 | 1 | 277.3 → 292.5 | 5.5% | 380.0 → 434.9 | 0 → 0 | 0.057% → 0.086% |
| muted | 512 | 2 | 286.1 → 307.6 | 7.5% | 406.4 → 418.5 | 0 → 0 | 0.114% → 0.143% |
| muted | 512 | 4 | 285.4 → 255.5 | -10.5% | 406.7 → 342.3 | 0 → 0 | 0.086% → 0.114% |

Cases where p95 varies by more than 1.5× between repetitions in at least one variant (descriptive variability flag, not a timing test):

- warp-small, buffer 128, 1 threads
- warp-small, buffer 128, 2 threads
- warp-small, buffer 128, 4 threads
- warp-small, buffer 512, 1 threads
- warp-small, buffer 512, 2 threads
- warp-small, buffer 512, 4 threads
- warp, buffer 512, 4 threads
- muted, buffer 128, 1 threads

Process CPU is normalized across all logical CPUs and includes benchmark bookkeeping and pacing. It is not the audio deadline load.

Before executable SHA-256: d10198ac76ac0ce7129c673e5199c5903937753ad326073b84e4e0c607638dd3

After executable SHA-256: 55bc754f330016843f395c3e0c366b380d6c3c288998817663e44395c407a44d
