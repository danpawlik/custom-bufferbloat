# Load generator benchmark

Measured on 2026-10-18, Linux amd64, Intel Core Ultra 7 165H,
Go 1.26.9-X:nodwarf5. Baseline: `cf3f039`, with the same benchmark file added.
Results are medians of three runs, with `GOMAXPROCS=4` set by `-cpu=4`.

```sh
go test ./internal/handlers -run '^$' -bench BenchmarkTransfer -benchmem -benchtime=1s -count=3 -cpu=4
```

The benchmark uses real HTTP over loopback, one sequential stream, no compression,
and a reusable in-memory upload body. It includes server upload accounting and HTTP
request/response overhead. Payload creation and server startup are outside the timed
region. It does not run browser JavaScript, calibration, or concurrent latency probes.

| Request | Before MB/s | After MB/s |
| --- | ---: | ---: |
| Download, 2 MiB | 3335 | 4206 |
| Download, 8 MiB | 4013 | 4897 |
| Download, 32 MiB | 4520 | 5547 |
| Upload, 256 KiB | 1957 | 2060 |
| Upload, 4 MiB | 3685 | 3632 |
| Upload, 16 MiB | 3267 | 3245 |

At identical download sizes, throughput improved by about 22–26%. The changes combine
an immutable 256 KiB server buffer with removal of per-block explicit flushing; this
benchmark does not isolate their individual contributions. Allocated bytes per 2 MiB
request dropped from 73,428 to 7,368 (client and server combined, about 90% less).

The upload handler is unchanged. Its similar before/after results are a control;
the benefit comes from fewer requests. In the updated version, 4 MiB uploads achieved
about 76% more throughput than 256 KiB uploads. Larger is not always faster: 16 MiB
was slower than 4 MiB here, so calibration still selects the best measured step.

Browser and CLI calibration now try downloads of 8/16/32 MiB and uploads of 4/8/16 MiB,
stopping early on a plateau as before. Stream limits, phase durations, byte accounting,
and grading formulas are unchanged. CLI download-only phases no longer allocate an
unused upload body. Upload payload preparation happens before the CLI phase timer starts.

## Limits and hardware follow-up

These are workstation loopback MB/s, not BPi-R4 Wi-Fi Mbps. There is no demonstrated
800 Mbps to 1 Gbps improvement on the router yet. Larger upload bodies increase client
memory usage (up to a 16 MiB reusable payload); the server does not buffer whole uploads.
The server keeps one 256 KiB download payload regardless of stream count.

For a hardware comparison, build the baseline and updated binaries for the same router,
then alternate runs using the same browser, Wi-Fi position/channel, and server placement.
Record CPU use, achieved throughput, latency, and calibration settings. Keep LibreSpeed's
speed compensation in mind when comparing its displayed results with raw payload rates.
