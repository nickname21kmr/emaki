import { sharp } from '../../src/services/image/sharpConfig.ts';

export async function animationHtml(delays = [30,60]): Promise<Buffer> {
  const frames = await Promise.all(delays.map(async (delay,index) => ({
    file:'data:application/octet-stream;base64,' + (await sharp({create:{width:4,height:3,channels:4,
      background:index % 2 ? '#00ff00' : '#ff0000'}}).png().toBuffer()).toString('base64'), delay,
  })));
  return Buffer.from(`<!doctype html><html><canvas></canvas><script>var frames_info=${JSON.stringify(frames)};</script></html>`);
}
