import { describe, expect, it } from 'vitest';
import { viewCsp, viewSrcdoc } from './frame';

describe('插件视图放进 iframe 之前（docs/plugins.md 第 5 节）', () => {
  const origin = 'http://127.0.0.1:5173';

  it('安全策略：不能联网；脚本只能内联和宿主的 /plugin-sdk/；图片只能是宿主发的短期地址和 data:、blob:', () => {
    const csp = viewCsp(origin);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain(`script-src 'unsafe-inline' ${origin}/plugin-sdk/`);
    expect(csp).toContain(`img-src ${origin}/api/plugin-media/ data: blob:`);
    expect(csp).not.toMatch(/\*|unsafe-eval/);
  });

  it('安全策略放在最前面：doctype 之后、页面自己的任何东西之前；没有 doctype 补一个', () => {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${viewCsp(origin)}">`;
    expect(viewSrcdoc('<!DOCTYPE html><html><head><script>x</script></head></html>', origin)).toBe(
      `<!DOCTYPE html>${meta}<html><head><script>x</script></head></html>`,
    );
    expect(viewSrcdoc('<script>evil()</script><p>hi</p>', origin)).toBe(`<!doctype html>${meta}<script>evil()</script><p>hi</p>`);
    expect(viewSrcdoc('  <!doctype html >\n<p>x</p>', origin)).toBe(`  <!doctype html >${meta}\n<p>x</p>`);
  });
});
