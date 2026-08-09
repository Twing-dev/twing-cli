/**
 * Length-prefixed JSON framing for the hook<->daemon Unix socket protocol.
 * Wire format: 4-byte big-endian uint32 byte length, followed by that many
 * bytes of UTF-8 JSON. Needed because stream sockets may coalesce or split
 * writes; a length prefix is the simplest way to recover message boundaries.
 */

const LENGTH_PREFIX_BYTES = 4;
const MAX_FRAME_BYTES = 10 * 1024 * 1024; // 10MB guard against a corrupt length prefix

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(LENGTH_PREFIX_BYTES);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Streaming decoder: feed it arbitrary chunks as they arrive on the socket,
 * get back zero or more complete parsed frames per chunk.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];

    for (;;) {
      if (this.buffer.length < LENGTH_PREFIX_BYTES) break;
      const bodyLength = this.buffer.readUInt32BE(0);
      if (bodyLength > MAX_FRAME_BYTES) {
        throw new Error(`twing wire protocol: frame length ${bodyLength} exceeds max ${MAX_FRAME_BYTES}`);
      }
      const frameEnd = LENGTH_PREFIX_BYTES + bodyLength;
      if (this.buffer.length < frameEnd) break;

      const body = this.buffer.subarray(LENGTH_PREFIX_BYTES, frameEnd);
      messages.push(JSON.parse(body.toString("utf8")));
      this.buffer = this.buffer.subarray(frameEnd);
    }

    return messages;
  }
}
