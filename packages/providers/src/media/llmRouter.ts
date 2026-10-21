type ImageRequest = {
  model: string;
  prompt: string;
  images?: unknown[];
  mask?: unknown;
  n?: number;
  ratio?: string;
  size?: string;
  quality?: string;
  outputFormat?: string;
  other?: Record<string, unknown>;
};

type MediaAsset = (
  | { mediaType: "image"; type: "url"; url: string }
  | { mediaType: "image"; type: "base64"; data: string; mimeType: string }
  | { mediaType: "image"; type: "binary"; data: Uint8Array; mimeType: string }) & { name?: string };

type Context = {
  config: { apiKey?: string };
  signal?: AbortSignal;
  tool: { fetch: typeof fetch; image: ImageConstructor };
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function imageAsset(value: unknown): MediaAsset {
  if (!record(value)) throw new Error("路由返回的图片格式无效。");
  if (typeof value.b64_json === "string" && value.b64_json.trim()) {
    const data = value.b64_json.replace(/\s/g, "");
    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      throw new Error("路由返回的图片数据不是有效的 Base64。");
    }
    // 通过文件签名判断格式，不假定默认结果一定是 PNG。
    let mimeType: string;
    if (data.startsWith("iVBORw0KGgo")) mimeType = "image/png";
    else if (data.startsWith("/9j/")) mimeType = "image/jpeg";
    else if (data.startsWith("R0lGODdh") || data.startsWith("R0lGODlh")) mimeType = "image/gif";
    else {
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      const bytes: number[] = [];
      for (let i = 0; i < Math.min(data.length, 16); i += 4) {
        const a = alphabet.indexOf(data[i]);
        const b = alphabet.indexOf(data[i + 1]);
        const c = alphabet.indexOf(data[i + 2]);
        const d = alphabet.indexOf(data[i + 3]);
        bytes.push((a << 2) | (b >> 4));
        if (c >= 0) bytes.push(((b & 15) << 4) | (c >> 2));
        if (d >= 0) bytes.push(((c & 3) << 6) | d);
      }
      if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
        && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") mimeType = "image/webp";
      else throw new Error("路由返回了无法识别的图片格式，请提供不含密钥的报错以便调整适配。");
    }
    return { mediaType: "image", type: "base64", data, mimeType };
  }
  if (typeof value.url === "string") {
    try {
      const url = new URL(value.url);
      if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) {
        return { mediaType: "image", type: "url", url: url.href };
      }
    } catch { /* 统一返回不含原始响应的错误。 */ }
  }
  throw new Error("路由没有返回有效的图片地址或图片数据。");
}

type ImagePipeline = {
  resize(width: number, height: number, options: { fit: "inside" }): ImagePipeline;
  png(options?: { compressionLevel?: number; palette?: boolean }): ImagePipeline;
  bytes(): Promise<Uint8Array>;
  metadata(): Promise<{ width: number; height: number; format: string }>;
};
type ImageConstructor = new (input: Uint8Array, options?: { maxPixels?: number; autoOrient?: boolean }) => ImagePipeline;
declare const Buffer: { from(value: string, encoding: "base64"): Uint8Array };

function joinBytes(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
function u32(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset);
}
function put32(data: Uint8Array, offset: number, value: number): void {
  new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(offset, value);
}
let crcTable: Uint32Array | undefined;
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let crc = i;
      for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      crcTable[i] = crc >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(data.length + 12);
  put32(chunk, 0, data.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8); put32(chunk, chunk.length - 4, crc32(chunk.subarray(4, chunk.length - 4)));
  return chunk;
}
function adler32(data: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) { a = (a + data[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}
// The native PNG encoder is explicitly requested to use zlib level 0.
// Only stored DEFLATE blocks are accepted here; arbitrary upstream PNGs never enter this decoder.
function inflateStored(data: Uint8Array, expected: number): Uint8Array {
  if (data.length < 6 || (data[0] & 15) !== 8 || ((data[0] << 8) + data[1]) % 31 || (data[1] & 32)) {
    throw new Error("图片处理工具返回了不兼容的 PNG 压缩头。");
  }
  const output = new Uint8Array(expected);
  let offset = 2, written = 0, last = false;
  while (!last) {
    if (offset + 5 > data.length - 4) throw new Error("图片处理数据不完整。");
    const block = data[offset++]; last = (block & 1) !== 0;
    if ((block & 6) !== 0) throw new Error("当前 Toonflow 图片工具不支持无压缩 PNG 输出，请更新 Toonflow 后重试。");
    const length = data[offset] | (data[offset + 1] << 8);
    const inverse = data[offset + 2] | (data[offset + 3] << 8); offset += 4;
    if ((length ^ inverse) !== 65535 || offset + length > data.length - 4 || written + length > expected) {
      throw new Error("图片处理数据长度无效。");
    }
    output.set(data.subarray(offset, offset + length), written); offset += length; written += length;
  }
  if (written !== expected || offset !== data.length - 4 || adler32(output) !== u32(data, offset)) {
    throw new Error("图片处理数据校验失败。");
  }
  return output;
}
function deflateStored(data: Uint8Array): Uint8Array {
  const output = new Uint8Array(2 + data.length + Math.ceil(data.length / 65535) * 5 + 4);
  output.set([0x78, 0x01]);
  let cursor = 2;
  for (let offset = 0; offset < data.length;) {
    const length = Math.min(65535, data.length - offset);
    output[cursor++] = offset + length === data.length ? 1 : 0;
    output[cursor++] = length & 255; output[cursor++] = length >>> 8;
    output[cursor++] = (~length) & 255; output[cursor++] = ((~length) >>> 8) & 255;
    output.set(data.subarray(offset, offset + length), cursor); cursor += length; offset += length;
  }
  put32(output, cursor, adler32(data)); return output;
}
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
  return da <= db && da <= dc ? a : db <= dc ? b : c;
}
function padNativePng(data: Uint8Array, width: number, height: number): Uint8Array {
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  if (signature.some((v, i) => data[i] !== v)) throw new Error("图片处理工具没有返回 PNG。");
  let header: Uint8Array | undefined;
  const idat: Uint8Array[] = [], profiles: Uint8Array[] = [];
  let ended = false;
  for (let offset = 8; offset + 12 <= data.length;) {
    const length = u32(data, offset), end = offset + 12 + length;
    if (end > data.length) throw new Error("PNG 数据不完整。");
    const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
    if (crc32(data.subarray(offset + 4, end - 4)) !== u32(data, end - 4)) throw new Error("PNG 校验失败。");
    const content = data.subarray(offset + 8, end - 4);
    if (type === "IHDR") header = content.slice();
    else if (type === "IDAT") idat.push(content);
    else if (["iCCP", "sRGB", "gAMA", "cHRM", "tRNS"].includes(type)) profiles.push(data.slice(offset, end));
    else if (type === "IEND") { ended = true; break; }
    offset = end;
  }
  if (!header || header.length !== 13 || !ended || !idat.length) throw new Error("PNG 缺少必要数据。");
  const sourceWidth = u32(header, 0), sourceHeight = u32(header, 4);
  const channels: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const count = channels[header[9]], depth = header[8];
  if (!count || ![8, 16].includes(depth) || header[10] || header[11] || header[12]
    || sourceWidth < 1 || sourceHeight < 1 || sourceWidth > width || sourceHeight > height
    || width * height > 4194304) throw new Error("图片处理工具返回了不兼容的 PNG 尺寸或编码。");
  const bpp = count * depth / 8, stride = sourceWidth * bpp;
  const raw = inflateStored(joinBytes(idat), (stride + 1) * sourceHeight);
  const pixels = new Uint8Array(stride * sourceHeight);
  for (let y = 0; y < sourceHeight; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error("PNG 行滤镜无效。");
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x, a = x >= bpp ? pixels[index - bpp] : 0;
      const b = y > 0 ? pixels[index - stride] : 0, c = x >= bpp && y > 0 ? pixels[index - stride - bpp] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : paeth(a, b, c);
      pixels[index] = raw[y * (stride + 1) + x + 1] + predictor;
    }
  }
  const targetStride = width * bpp, rows = new Uint8Array((targetStride + 1) * height);
  rows.fill(255); // Opaque white padding, including alpha for GA/RGBA images.
  for (let y = 0; y < height; y++) rows[y * (targetStride + 1)] = 0;
  const left = Math.floor((width - sourceWidth) / 2), top = Math.floor((height - sourceHeight) / 2);
  for (let y = 0; y < sourceHeight; y++) {
    rows.set(pixels.subarray(y * stride, (y + 1) * stride), (top + y) * (targetStride + 1) + 1 + left * bpp);
  }
  put32(header, 0, width); put32(header, 4, height);
  return joinBytes([signature, pngChunk("IHDR", header), ...profiles, pngChunk("IDAT", deflateStored(rows)), pngChunk("IEND", new Uint8Array())]);
}
async function checkImageTools(context: Context, signal: AbortSignal): Promise<void> {
  const header = new Uint8Array(13); put32(header, 0, 1); put32(header, 4, 1); header[8] = 8; header[9] = 6;
  const sample = joinBytes([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header),
    pngChunk("IDAT", deflateStored(new Uint8Array([0, 255, 255, 255, 255]))), pngChunk("IEND", new Uint8Array())]);
  signal.throwIfAborted();
  const output = await new context.tool.image(sample).resize(2, 2, { fit: "inside" }).png({ compressionLevel: 0, palette: false }).bytes();
  signal.throwIfAborted();
  const padded = padNativePng(output, 3, 2);
  const final = await new context.tool.image(padded).png().bytes();
  const meta = await new context.tool.image(final).metadata();
  signal.throwIfAborted();
  if (meta.width !== 3 || meta.height !== 2) throw new Error("当前 Toonflow 图片工具未通过尺寸检查，未发起生成请求。");
}
function targetCanvas(request: ImageRequest): { width: number; height: number; size: string } {
  const ratios: Record<string, [number, number]> = { "1:1": [2048, 2048], "16:9": [2048, 1152], "9:16": [1152, 2048] };
  const size = request.size ?? "2K";
  let dimensions: [number, number];
  if (size === "2K") {
    const ratioKey = request.ratio ?? "16:9";
    if (!Object.prototype.hasOwnProperty.call(ratios, ratioKey)) throw new Error("当前输出画布支持 1:1、16:9、9:16 三种比例。");
    dimensions = ratios[ratioKey];
    if (!dimensions) throw new Error("当前输出画布支持 1:1、16:9、9:16 三种比例。");
  } else {
    const exact: Record<string, [number, number]> = {
      "2048x1152": [2048, 1152], "1152x2048": [1152, 2048], "2048x2048": [2048, 2048], "1024x1024": [1024, 1024],
    };
    if (!Object.prototype.hasOwnProperty.call(exact, size)) throw new Error("请选择 2K 或模型列表中的明确像素尺寸。");
    dimensions = exact[size];
    if (!dimensions) throw new Error("请选择 2K 或模型列表中的明确像素尺寸。");
    if (request.ratio !== undefined) {
      if (!Object.prototype.hasOwnProperty.call(ratios, request.ratio)) throw new Error("当前输出画布支持 1:1、16:9、9:16 三种比例。");
      const ratio = ratios[request.ratio];
      if (!ratio || dimensions[0] * ratio[1] !== dimensions[1] * ratio[0]) throw new Error("比例与像素尺寸不一致。");
    }
  }
  return { width: dimensions[0], height: dimensions[1], size: `${dimensions[0]}x${dimensions[1]}` };
}
async function normalizeCanvas(context: Context, asset: MediaAsset, target: {width: number; height: number}, signal: AbortSignal): Promise<MediaAsset[]> {
  signal.throwIfAborted();
  let bytes: Uint8Array;
  if (asset.type === "base64") bytes = Buffer.from(asset.data, "base64");
  else if (asset.type === "binary") bytes = asset.data;
  else {
    const response = await context.tool.fetch(asset.url, { signal }); // Never forward the application key to an image URL.
    if (!response.ok) throw new Error("生成已完成，但下载图片失败，请检查路由记录，不要立即重复生成。");
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  signal.throwIfAborted();
  if (bytes.length > 67108864) throw new Error("生成图片超过 64 MB，无法安全处理。");
  const image = new context.tool.image(bytes, { maxPixels: 33554432, autoOrient: true });
  const original = await image.metadata();
  signal.throwIfAborted();
  const output = await image.resize(target.width, target.height, { fit: "inside" }).png({ compressionLevel: 0, palette: false }).bytes();
  signal.throwIfAborted();
  const padded = padNativePng(output, target.width, target.height);
  const final = await new context.tool.image(padded, { maxPixels: 4194304 }).png().bytes();
  signal.throwIfAborted();
  const meta = await new context.tool.image(final).metadata();
  if (meta.width !== target.width || meta.height !== target.height) throw new Error("图片已生成，但输出画布尺寸校验失败，请勿立即重复生成。");
  const result: MediaAsset[] = [{ mediaType: "image", type: "binary", data: final, mimeType: "image/png", name: `llmrouter-${target.width}x${target.height}.png` }];
  if (original.width !== target.width || original.height !== target.height) {
    result.push({ mediaType: "image", type: "binary", data: bytes, mimeType: original.format === "jpeg" ? "image/jpeg" : `image/${original.format}`, name: `llmrouter-original-${original.width}x${original.height}.${original.format}` });
  }
  return result;
}

export default {
  id: "llmRouter",
  label: "LLMRouter 图片生成",
  version: "2.0.2",
  apiUrl: "http://192.168.1.15:18080/v1",
  readme: "通过内部 LLMRouter 使用 gpt-image-2.5 文字画图。尺寸选项代表最终输出画布，不代表上游原生分辨率。2K 表示长边 2048；16:9 对应 2048x1152，9:16 对应 1152x2048，1:1 对应 2048x2048。缺省为 2K、16:9。上游返回尺寸不符时，等比缩放、居中补白边，不裁切或拉伸；调整后的 PNG 在前，原图在后。放大不会增加原生细节。需要支持 Bun.Image 的 Toonflow。只支持一次生成一张，不支持参考图、自选画质或额外参数。最长等待十分钟；取消不代表上游停止，请查询记录后再决定是否重试。",
  rules: [{
    type: "input",
    field: "apiKey",
    title: "LLMRouter 访问密钥",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
    validate: [{ required: true, whitespace: true, message: "请填写 LLMRouter 的应用访问密钥", trigger: "blur" }],
  }],
  models: [
    {
      "id": "gpt-image-2.5",
      "label": "gpt-image-2.5（文字画图）",
      "type": "image",
      "mode": [
        "text"
      ],
      "imageSizes": [
        "2K",
        "2048x1152",
        "1152x2048",
        "2048x2048",
        "1024x1024"
      ],
      "imageRatios": [
        "16:9",
        "9:16",
        "1:1"
      ]
    }
  ],
  async generateImage(this: Context, request: ImageRequest): Promise<MediaAsset[]> {
    this.signal?.throwIfAborted();
    const apiKey = typeof this.config.apiKey === "string" ? this.config.apiKey.trim() : "";
    if (!apiKey) throw new Error("请先在供应商配置中填写 LLMRouter 访问密钥。");
    if (request.model !== "gpt-image-2.5") throw new Error("此适配器只支持 gpt-image-2.5。");
    if (typeof request.prompt !== "string" || !request.prompt.trim()) throw new Error("请填写想画的内容。");
    if (request.images !== undefined && (!Array.isArray(request.images) || request.images.length > 0)
      || request.mask !== undefined) throw new Error("当前版本只支持文字画图，请移除参考图和蒙版。");
    if (request.n !== undefined && request.n !== 1) throw new Error("当前版本每次只生成一张图片。");
    const target = targetCanvas(request);
    const size = target.size;
    if (typeof this.tool.image !== "function") throw new Error("当前 Toonflow 缺少图片处理工具，请更新 Toonflow 后再生成。");
    if (request.quality !== undefined || (request.outputFormat !== undefined && request.outputFormat !== "png")) {
      throw new Error("当前版本使用平台默认画质和编码格式，请取消自选画质和格式。");
    }
    if (request.other !== undefined && (!record(request.other) || Object.keys(request.other).length > 0)) {
      throw new Error("当前版本不支持额外生成参数。");
    }

    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort(this.signal?.reason);
    this.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 600000);
    let phase: "prepare" | "request" | "process" = "prepare";
    try {
      this.signal?.throwIfAborted();
      await checkImageTools(this, controller.signal);
      phase = "request";
      const response = await this.tool.fetch("http://192.168.1.15:18080/v1/images/generations", {
        method: "POST",
        redirect: "error",
        headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ model: request.model, prompt: request.prompt.trim(), n: 1, size }),
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401) throw new Error("访问密钥无效或已失效，请检查 Toonflow 中填写的 LLMRouter 密钥。");
        if (response.status === 403) throw new Error("此密钥没有调用该模型的权限，请检查路由中的应用授权。");
        if (response.status === 404) throw new Error("路由未找到接口或 gpt-image-2.5 模型，请检查路由配置。");
        if (response.status === 429) throw new Error("请求过于频繁或额度不足，请查看路由中的额度和调用记录。");
        throw new Error("图片生成失败，HTTP " + response.status + "。请查看路由调用记录后再决定是否重试。");
      }
      let payload: unknown;
      try { payload = await response.json(); }
      catch { throw new Error("路由返回的内容不是有效的 JSON 图片结果。"); }
      controller.signal.throwIfAborted();
      if (!record(payload) || !Array.isArray(payload.data) || payload.data.length === 0) {
        throw new Error("路由未返回最终图片，请查看该次调用记录。");
      }
      phase = "process";
      const assets = payload.data.map(imageAsset);
      const results: MediaAsset[] = [];
      for (const asset of assets) results.push(...await normalizeCanvas(this, asset, target, controller.signal));
      return results;
    } catch (error) {
      if (this.signal?.aborted) throw new Error("已停止等待图片；上游可能仍在生成，请查看路由调用记录。");
      if (timedOut) throw new Error("等待图片超过 10 分钟；上游可能仍在生成，请查看路由调用记录后再决定是否重试。");
      // 网络错误可能包含请求信息，不向用户回显底层消息。
      if (phase === "prepare") throw new Error("当前 Toonflow 图片处理工具不兼容，未发起生成请求。请更新 Toonflow；" + (error instanceof Error ? error.message : "工具检查失败"));
      if (phase === "process") throw new Error("上游图片已生成，但画布处理失败，请勿立即重复生成。" + (error instanceof Error ? error.message : "图片工具异常"));
      if (error instanceof TypeError) throw new Error("无法连接图片服务，请确认 Toonflow 服务端能访问 192.168.1.15:18080。");
      throw error;
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener("abort", cancel);
    }
  },
};
