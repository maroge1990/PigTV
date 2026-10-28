# Synthetic HE-AAC fixture

One second of a 440 Hz sine tone, stereo HE-AAC at 48 kHz / 64 kbit/s. Generated on macOS with FFmpeg 9.0.2:

```
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=48000 -t 1 -c:a aac_at -profile:a 4 -b:a 64k -ac 2 -f adts synthetic-heaac.aac
```

No broadcast or captured media. Linux can decode/copy HE-AAC but the production build cannot synthesize it (no nonfree
FDK encoder or macOS AudioToolbox). Loop this fixture so real recording tests exercise HE-AAC on Linux too.
