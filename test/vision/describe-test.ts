// test/vision/describe-test.ts —— vision.ts 的独立功能测试。
// 生成一张含中文文字的测试图（程序化绘制，不依赖外部图片），
// 走完整的「图片字节 → describeImage → 中文描述」链路。
// 用法：npx tsx --env-file=.env test/vision/describe-test.ts
//（.env 需要配置 VISION_API_KEY；无 .env 时用环境变量传入也行）

import { describeImage } from "../../src/services/vision.js";

// 程序化生成测试图：不依赖任何外部图片文件。
// 用 Node 内置能力画不了字，所以借 Canvas 不现实——直接手搓一张 BMP：
// 结构简单（54 字节头 + 像素阵列），Qwen 支持识别 BMP，还能验证"非 PNG 格式也行"。
function makeTestBitmap(): { bytes: Uint8Array; mimeType: string } {
  const width = 64;
  const height = 32;
  const rowSize = width * 3; // 24 位色，无 padding（64*3=192 已是 4 的倍数）
  const pixelArraySize = rowSize * height;
  const fileSize = 54 + pixelArraySize;

  const buf = Buffer.alloc(fileSize);
  // BITMAPFILEHEADER
  buf.write("BM", 0, "ascii");
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10); // 像素数据偏移
  // BITMAPINFOHEADER
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26); // planes
  buf.writeUInt16LE(24, 28); // bpp
  buf.writeUInt32LE(0, 30); // 无压缩
  buf.writeUInt32LE(pixelArraySize, 34);

  // 像素：上半红、下半蓝，中间一条白带——内容简单但足以验证"模型真的看懂了"
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = 54 + y * rowSize + x * 3;
      if (y >= 14 && y < 18) {
        buf[offset] = 255; buf[offset + 1] = 255; buf[offset + 2] = 255; // 白带 BGR
      } else if (y < 14) {
        buf[offset] = 40; buf[offset + 1] = 40; buf[offset + 2] = 200; // 红色 BGR
      } else {
        buf[offset] = 200; buf[offset + 1] = 60; buf[offset + 2] = 40; // 蓝色 BGR
      }
    }
  }
  return { bytes: buf, mimeType: "image/bmp" };
}

async function main(): Promise<void> {
  console.log("[vision-test] 生成测试图（红/白带/蓝三段 BMP）…");
  const { bytes, mimeType } = makeTestBitmap();
  console.log(`[vision-test] 图片 ${bytes.length} 字节，MIME ${mimeType}`);

  console.log("[vision-test] 调用 describeImage…");
  const description = await describeImage(bytes, mimeType);
  console.log(`[vision-test] ✅ 描述（${description.length} 字）：`);
  console.log(description);
  console.log("\n[vision-test] 期望包含：红色、蓝色、白色/横条之类的描述。");
}

main().catch((err: unknown) => {
  console.error("[vision-test] ❌ 失败:", err instanceof Error ? err.message : err);
  process.exit(1);
});
