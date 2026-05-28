import { describe, expect, it } from 'vitest';
import { standaloneBrowserDisabledResponse, standaloneLoginResponse } from '../src/standalone/login-page.js';

describe('standalone login pages', () => {
  it('renders login page metadata and escapes URLs', () => {
    const html = standaloneLoginResponse({
      authenticated: false,
      bindUrl: 'http://0.0.0.0:4101/?x=<script>',
      localUrl: 'http://127.0.0.1:4101/?q="taori"',
    });

    expect(html).toContain('Taori Browser Access');
    expect(html).toContain('输入访问密码');
    expect(html).toContain('Bind: http://0.0.0.0:4101/?x=&lt;script&gt;');
    expect(html).toContain('Local: http://127.0.0.1:4101/?q=&quot;taori&quot;');
    expect(html).not.toContain('Bind: http://0.0.0.0:4101/?x=<script>');
  });

  it('renders browser disabled page and escapes fallback URLs', () => {
    const html = standaloneBrowserDisabledResponse({
      bindUrl: null,
      localUrl: "http://127.0.0.1:4102/?q='taori'",
    });

    expect(html).toContain('Taori 浏览器入口未启用');
    expect(html).toContain('--password');
    expect(html).toContain('Bind: n/a');
    expect(html).toContain('Local: http://127.0.0.1:4102/?q=&#39;taori&#39;');
  });
});
