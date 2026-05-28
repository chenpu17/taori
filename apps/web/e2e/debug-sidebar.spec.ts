import { test } from '@playwright/test';
test('debug: what does sidebar show', async ({ page }) => {
  await page.goto('http://localhost:3456/');
  await page.waitForSelector('.app');
  await page.waitForTimeout(3000);
  
  // Get all sidebar item texts
  const items = await page.locator('.side-item').allTextContents();
  console.log('Sidebar items:', JSON.stringify(items, null, 2));
  
  // Check if in live mode
  const isLive = await page.evaluate(() => {
    const sideItems = document.querySelectorAll('.side-item');
    const sections = document.querySelectorAll('.side-section');
    return { sideItemCount: sideItems.length, sections: Array.from(sections).map(s => s.textContent) };
  });
  console.log('Layout info:', JSON.stringify(isLive));
  
  await page.screenshot({ path: '/tmp/taori-multi/debug-sidebar.png' });
});
