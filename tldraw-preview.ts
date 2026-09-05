import { inflateRawSync } from "node:zlib";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

function findEndOfCentralDirectory(archive: Buffer): number {
  const minimumOffset = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }
  return -1;
}

function isPng(value: Buffer): boolean {
  return (
    value.length >= 8 &&
    value[0] === 0x89 &&
    value.subarray(1, 4).toString("ascii") === "PNG" &&
    value[4] === 0x0d &&
    value[5] === 0x0a &&
    value[6] === 0x1a &&
    value[7] === 0x0a
  );
}

export function extractTldrawPreviewDataUrl(archive: Buffer): string | null {
  try {
    const endOffset = findEndOfCentralDirectory(archive);
    if (endOffset < 0) return null;
    const entryCount = archive.readUInt16LE(endOffset + 10);
    let entryOffset = archive.readUInt32LE(endOffset + 16);

    for (let index = 0; index < entryCount; index += 1) {
      if (archive.readUInt32LE(entryOffset) !== CENTRAL_DIRECTORY_ENTRY) {
        return null;
      }
      const compressionMethod = archive.readUInt16LE(entryOffset + 10);
      const compressedSize = archive.readUInt32LE(entryOffset + 20);
      const uncompressedSize = archive.readUInt32LE(entryOffset + 24);
      const fileNameLength = archive.readUInt16LE(entryOffset + 28);
      const extraLength = archive.readUInt16LE(entryOffset + 30);
      const commentLength = archive.readUInt16LE(entryOffset + 32);
      const localHeaderOffset = archive.readUInt32LE(entryOffset + 42);
      const fileName = archive
        .subarray(entryOffset + 46, entryOffset + 46 + fileNameLength)
        .toString("utf8");

      if (fileName === "preview.png") {
        if (
          uncompressedSize > MAX_PREVIEW_BYTES ||
          archive.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_HEADER
        ) {
          return null;
        }
        const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
        const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
        const dataOffset =
          localHeaderOffset + 30 + localNameLength + localExtraLength;
        const compressed = archive.subarray(
          dataOffset,
          dataOffset + compressedSize,
        );
        const preview =
          compressionMethod === 0
            ? compressed
            : compressionMethod === 8
              ? inflateRawSync(compressed, {
                  maxOutputLength: MAX_PREVIEW_BYTES,
                })
              : null;
        if (!preview || preview.length > MAX_PREVIEW_BYTES || !isPng(preview)) {
          return null;
        }
        return `data:image/png;base64,${preview.toString("base64")}`;
      }

      entryOffset += 46 + fileNameLength + extraLength + commentLength;
    }
  } catch {
    return null;
  }
  return null;
}
