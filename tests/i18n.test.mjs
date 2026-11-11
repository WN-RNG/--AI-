import assert from 'node:assert/strict';
import test from 'node:test';
import { translateUi, translateUploadIssue } from '../src/uiTranslations.ts';

test('UI translation keeps authored and unknown content verbatim', () => {
  for (const value of [
    '京都 · 夏天 2026',
    'IMG_光影.jpg',
    'Jean & 李',
    '__proto__',
    'constructor',
  ]) {
    assert.equal(translateUi('en', value), value);
    assert.equal(translateUi('zh', value), value);
  }
});

test('count interpolation uses the selected language and treats user values as literal text', () => {
  assert.equal(translateUi('en', '已选择 {count} 张', { count: 12 }), '12 selected');
  assert.equal(translateUi('zh', '已选择 {count} 张', { count: 12 }), '已选择 12 张');
  assert.equal(translateUi('en', '{name}', { name: '$& <photo> {count}' }), '$& <photo> {count}');
  assert.equal(translateUi('en', 'Saved {count} / {total}', { count: 2 }), 'Saved 2 / {total}');
});

test('authentication and consent copy switch without changing the permission itself', () => {
  assert.equal(translateUi('en', '邀请码不正确'), 'The invitation code is incorrect.');
  assert.equal(translateUi('zh', '邀请码不正确'), '邀请码不正确');
  assert.equal(
    translateUi('en', '允许登录用户下载这些照片的展示图'),
    'Allow logged-in visitors to download display images',
  );
  assert.equal(translateUi('zh', 'Gallery'), '公共图库');
  assert.equal(translateUi('en', ' 已保留'), ' Keeper');
});

test('upload error formatter preserves the full filename, including punctuation and Chinese characters', () => {
  const name = '光影：第二章 <photo>$&.tiff';
  const issue = `${name}：仅支持 JPG、PNG 或 WebP 图片，已跳过`;
  assert.equal(
    translateUploadIssue('en', issue),
    `${name}: Only JPG, PNG or WebP photographs are supported. Skipped.`,
  );
  assert.equal(translateUploadIssue('zh', issue), issue);
  assert.equal(translateUploadIssue('en', `${name}：未知错误`), `${name}：未知错误`);
});

test('known service error status remains visible in translated feedback', () => {
  assert.equal(translateUi('en', '请求失败（503）'), 'Request failed (503).');
  assert.equal(
    translateUi('en', '下载失败（403），请稍后重试'),
    'Download failed (403). Please try again.',
  );
  assert.equal(
    translateUi('en', '服务响应格式异常（502），请稍后重试'),
    'Unexpected response format (502). Please try again.',
  );
  assert.equal(translateUi('zh', '请求失败（503）'), '请求失败（503）');
  assert.equal(translateUi('en', 'IMG_请求失败（503）.jpg'), 'IMG_请求失败（503）.jpg');
});
