import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const values = {
    out: path.resolve("samples", "stress-import"),
    tracks: 8,
    seconds: 150,
    sampleRate: 44_100,
    channels: 2,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--out" && next) {
      values.out = path.resolve(next);
      index += 1;
    } else if (arg === "--tracks" && next) {
      values.tracks = Number(next);
      index += 1;
    } else if (arg === "--seconds" && next) {
      values.seconds = Number(next);
      index += 1;
    } else if (arg === "--sample-rate" && next) {
      values.sampleRate = Number(next);
      index += 1;
    } else if (arg === "--channels" && next) {
      values.channels = Number(next);
      index += 1;
    }
  }

  return values;
}

function writeWavHeader(stream, { channels, sampleRate, totalFrames }) {
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = totalFrames * blockAlign;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);

  stream.write(header);
}

function sampleValue(frameIndex, trackIndex, channelIndex, sampleRate) {
  const baseFrequency = 110 + trackIndex * 27;
  const harmonicFrequency = baseFrequency * (channelIndex === 0 ? 1 : 1.5);
  const timeSeconds = frameIndex / sampleRate;
  const envelope = 0.55 + Math.sin(timeSeconds * 0.35 + trackIndex) * 0.2;
  const tone =
    Math.sin(timeSeconds * Math.PI * 2 * baseFrequency) * 0.55 +
    Math.sin(timeSeconds * Math.PI * 2 * harmonicFrequency) * 0.18;
  const clamped = Math.max(-0.95, Math.min(0.95, tone * envelope));
  return Math.round(clamped * 32_767);
}

async function writeStressTrack(filePath, trackIndex, options) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

  const stream = fs.createWriteStream(filePath);
  const totalFrames = options.sampleRate * options.seconds;
  const framesPerChunk = options.sampleRate * 2;
  writeWavHeader(stream, {
    channels: options.channels,
    sampleRate: options.sampleRate,
    totalFrames,
  });

  for (let chunkStart = 0; chunkStart < totalFrames; chunkStart += framesPerChunk) {
    const chunkFrames = Math.min(framesPerChunk, totalFrames - chunkStart);
    const buffer = Buffer.alloc(chunkFrames * options.channels * 2);
    let offset = 0;

    for (let frameOffset = 0; frameOffset < chunkFrames; frameOffset += 1) {
      const frameIndex = chunkStart + frameOffset;

      for (let channelIndex = 0; channelIndex < options.channels; channelIndex += 1) {
        buffer.writeInt16LE(
          sampleValue(frameIndex, trackIndex, channelIndex, options.sampleRate),
          offset,
        );
        offset += 2;
      }
    }

    if (!stream.write(buffer)) {
      await new Promise((resolve) => stream.once("drain", resolve));
    }
  }

  await new Promise((resolve, reject) => {
    stream.end(() => resolve());
    stream.on("error", reject);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await fs.promises.mkdir(options.out, { recursive: true });

  for (let trackIndex = 0; trackIndex < options.tracks; trackIndex += 1) {
    const fileName = `stress-track-${String(trackIndex + 1).padStart(2, "0")}.wav`;
    const filePath = path.join(options.out, fileName);
    await writeStressTrack(filePath, trackIndex, options);
  }

  process.stdout.write(
    `Generated ${options.tracks} WAV files in ${options.out} (${options.seconds}s each)\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
