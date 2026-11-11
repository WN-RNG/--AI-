# 500px 首页轮播与 Python 环境

## Python 环境

Python 官方完整运行包 **3.14.10 / 64 位**位于 `.tools/python-3.14.10`，独立虚拟环境在 `.venv`，已包含 pip。安装前核对了 Python 官网清单与 ZIP 的 SHA-256；不修改系统 PATH、注册表或其他项目。图片处理沿用现有 Node/Sharp，Python 无需额外第三方包。

无需激活环境，在项目根目录执行：

```powershell
.\.venv\Scripts\python.exe -X utf8 -B --version
.\.venv\Scripts\python.exe -X utf8 -B -m pip --version
```

其他 Windows 电脑首次配置，或需要重复检查环境时执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-python.ps1
```

`.tools/`、`.venv/` 已加入 Git 忽略，不能把本机运行环境、临时签名下载地址提交到 GitHub。移动项目位置后应重新创建虚拟环境，其中记录了原运行时路径。

## 一键更新

双击根目录 **更新首页封面.cmd**。它检查 Python，在独立 Edge/Chrome 后台会话中，通过 500px 可见搜索框查找风景作品，读取作品页实际展示的图片地址，下载、优化后更新首页素材清单。

也可以运行：

```powershell
.\.venv\Scripts\python.exe -X utf8 -B scripts/sync-500px-covers.py --count 6
```

原始入口是用户提供的 `https://500px.com/search?q=自然风景&type=Photo`。默认通过页面搜索框输入 **nature landscape**，减少动物、微距等混合结果；可用 `--query "mountain landscape"` 指定其他摄影主题。每次最多获取 6 张，以风景标题关键词及宽高比例筛选，在候选中随机选择；不代表 AI 审美评分。

程序保留原有三套封面，替换素材池中的 `500px-` 照片。保留真实作品标题、作者和来源链接。使用页面实际提供的展示图，**不是原图**；清晰度以平台展示版本为准，不重写签名参数，不移除水印。

验证码、登录要求、访问限制或下载失败会中止更新，旧轮播清单继续有效。不读取平时浏览器的登录信息，也不自动登录或绕过限制。每次更新有数量与时间上限，没有常驻爬虫或定时任务。

## 首页与部署

素材位于 `public/covers`，清单为 `manifest.json`。后端 `/covers` 路由直接读取当前素材，JSON 不缓存。更新成功后**刷新首页**即可加载新清单；已打开的页面在刷新前会继续播放原列表。

首次应用本次后端改动，用原来的 `启动相册.cmd` 重启服务一次。之后只更新封面时，无需重新构建前端或重启 Node。

首页没有这些图片的下载、收藏或明信片入口，素材不混入用户相册。浏览器显示图片必然接收图片，产品无法彻底禁止截图或浏览器取图。素材用途沿用项目所有者确认的首页展示范围，公开可访问本身不代表作品可任意再使用。

Python 采集在本机运行即可，不需要在 Render 免费实例中安装浏览器或常驻 Python。线上更新需要将本次相关代码和 `public/covers` 提交仓库并重新部署；本次操作不自动提交或部署。旧封面文件不自动删除，避免旧页面断图。数据库和用户照片不属于此素材池。

## 手动导入文件或直链

复制 `scripts/cover-sources.example.json` 到私有配置位置，填写具体照片文件或直接 HTTPS 图片地址：

```powershell
.\.venv\Scripts\python.exe -X utf8 -B scripts/import-covers.py "C:\我的素材\cover-sources.json" --dry-run
.\.venv\Scripts\python.exe -X utf8 -B scripts/import-covers.py "C:\我的素材\cover-sources.json"
```

直接导入会整体替换清单；保留三套默认封面并获取 500px 图片时，请使用上面的同步命令。相对路径以配置文件目录为基准；URL 使用 HTTPS，下载域名逐个列在 `allowedHosts`。私有配置和原始下载地址不要放入 `public`。

每张输入上限 30 MiB / 8000 万像素。图片纠正方向、移除 EXIF/GPS、保持比例，压缩为不超过 2560×1800 的 WebP。全部成功才原子替换清单，原始素材保持不变。

## 验证

```powershell
.\.venv\Scripts\python.exe -X utf8 -B -m unittest discover -s tests -p "test_cover*.py"
node --test tests/coverImport.test.mjs tests/coverAssets.test.mjs tests/collect500px.test.mjs tests/homeCover.test.mjs
```

`-B` 避免在源代码目录产生 Python 字节码缓存。
