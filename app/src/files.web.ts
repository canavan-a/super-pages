// Browser versions of src/files.ts: an <input type=file> to pick, and a
// temporary object URL to download.
import {base64} from '@scure/base';

import {unutf8, utf8} from './crypto';

export interface PickedFile {
  name: string;
  mime: string;
  data: Uint8Array;
  w?: number;
  h?: number;
}

function pick(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.click();
  });
}

async function read(f: File): Promise<PickedFile> {
  return {
    name: f.name,
    mime: f.type || 'application/octet-stream',
    data: new Uint8Array(await f.arrayBuffer()),
  };
}

export interface TextFile {
  name: string;
  text: string;
}

export async function pickTextFile(): Promise<TextFile | null> {
  const [f] = await pick('.json,application/json', false);
  if (!f) return null;
  if (f.size > 64 * 1024)
    throw new Error(`${f.name} is too big to be a key file.`);
  return {name: f.name, text: unutf8(new Uint8Array(await f.arrayBuffer()))};
}

export interface SavedFile {
  name: string;
  location: string;
}

// Browsers have no save dialog to open first; these just download.
export async function saveFileAs(
  name: string,
  _mime: string,
  makeData: () => Promise<Uint8Array>,
): Promise<SavedFile | null> {
  return saveFile(name, await makeData());
}

export async function saveTextFileAs(
  name: string,
  makeText: () => Promise<string>,
): Promise<SavedFile | null> {
  return saveFile(name, utf8(await makeText()));
}

async function saveFile(name: string, data: Uint8Array): Promise<SavedFile> {
  const url = URL.createObjectURL(new Blob([data]));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return {name, location: "your browser's downloads"};
}

// Picked images are scaled to fit 2048px and re-encoded, which also drops
// their EXIF (location etc.), as the phone picker does. WebP keeps
// transparency; browsers that can't encode it get a JPEG.
async function shrink(f: File): Promise<PickedFile> {
  if (f.type === 'image/gif') return read(f);
  const img = await createImageBitmap(f);
  const scale = Math.min(1, 2048 / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  let blob = await new Promise<Blob | null>(res =>
    canvas.toBlob(res, 'image/webp', 0.85),
  );
  if (!blob || blob.type !== 'image/webp')
    blob = await new Promise<Blob | null>(res =>
      canvas.toBlob(res, 'image/jpeg', 0.85),
    );
  if (!blob) throw new Error(`Couldn't read ${f.name}.`);
  return {
    name: f.name,
    mime: blob.type,
    data: new Uint8Array(await blob.arrayBuffer()),
    w: canvas.width,
    h: canvas.height,
  };
}

export async function pickImages(): Promise<PickedFile[]> {
  return Promise.all((await pick('image/*', true)).slice(0, 6).map(shrink));
}

export async function pickFiles(): Promise<PickedFile[]> {
  return Promise.all((await pick('*/*', true)).slice(0, 6).map(read));
}

export function dataUri(mime: string, data: Uint8Array): string {
  return `data:${mime};base64,${base64.encode(data)}`;
}

/** A photo picked to become a profile picture, before cropping (see files.ts). */
export interface AvatarSource {
  base64: string;
  width: number;
  height: number;
}

export const AVATAR_SIZE = 512;

const toJpeg = async (
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Uint8Array> => {
  const blob = await new Promise<Blob | null>(res =>
    canvas.toBlob(res, 'image/jpeg', quality),
  );
  if (!blob) throw new Error("Couldn't read that image.");
  return new Uint8Array(await blob.arrayBuffer());
};

/** Picks the photo to crop, re-encoded at up to 1600px (which also drops its EXIF). Null if cancelled. */
export async function pickAvatarSource(): Promise<AvatarSource | null> {
  const [f] = await pick('image/*', false);
  if (!f) return null;
  const img = await createImageBitmap(f);
  const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return {
    base64: base64.encode(await toJpeg(canvas, 0.9)),
    width: canvas.width,
    height: canvas.height,
  };
}

/** Cuts the framed square (in source pixels) out and scales it to AVATAR_SIZE, as a JPEG. */
export async function cropAvatar(
  src: AvatarSource,
  x: number,
  y: number,
  size: number,
): Promise<Uint8Array> {
  const img = await createImageBitmap(
    new Blob([base64.decode(src.base64)], {type: 'image/jpeg'}),
  );
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = AVATAR_SIZE;
  canvas
    .getContext('2d')!
    .drawImage(img, x, y, size, size, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  return toJpeg(canvas, 0.85);
}
