# 本地安装、源码定位与更新

## 一次安装

客户先取得 `codex/personal-cloudbase` 分支的完整 Git 克隆或 ZIP 解压目录；安装时在该仓库根目录执行 `npm run skill:install`。也可直接执行 `node skills/bifang-public-services-onboarding/scripts/local-source.mjs install`。只需要 Node.js >=20，不需要先 npm ci，不访问网络。安装/更新请求不触发客户接入问答。

脚本从自身位置识别源码根目录，不要求固定盘符、目录名或客户再次填写路径。检查个人模式 manifest、Skill 元数据和必需工具/函数/文档；Git 副本须实际位于 `codex/personal-cloudbase`，ZIP 副本按个人模式声明和文件完整性检查，并标明 archive，不能冒充已核验 Git 分支。此检查证明结构和模式匹配，不代替客户对下载来源的信任。

安装到 `$CODEX_HOME/skills/bifang-public-services-onboarding`；未设置 CODEX_HOME 时使用当前用户 `~/.codex/skills/bifang-public-services-onboarding`。原同名目录备份到同一 Codex 根目录的 `skill-backups/bifang-public-services-onboarding/<本次标识>/previous`，暂存和备份均在技能加载目录之外。校验复制前后所有 Skill 文件的 SHA-256，一起写入仅本机使用的 `.source-location.json`，记录源码绝对路径、版本、分支和安装摘要；不保存凭据。不要手工只复制 Skill 目录而漏掉绑定步骤。重复运行安装命令即可更新并重新绑定；不使用默认分支旧 bootstrap 或网络安装器替代本地内容。

## 每次调用

1. 从本次已加载的 SKILL.md 的实际目录定位 `scripts/local-source.mjs`，执行 `node <该脚本实际绝对路径> resolve`；路径含空格时引用。助手填好路径，用户调用 Skill 时不用填写。
2. 优先使用显式 `--source` 指定的目录（仅用户已有明确指定时），否则使用 Skill 自身所在源码仓库、安装记录中的源码目录。记录对应目录仍存在但模式/分支/文件不匹配时停止并说明原因，不能静默换公司分支或另一副本。
3. 记录目录不存在或没有安装记录时，仅检查旧目录的父目录、当前工作目录及向上最多两级、当前用户 Downloads；每处只检查本层及一层子目录的固定仓库标识，不递归全盘扫描，不搜索客户业务文件、凭据或 node_modules。任何目录超过 200 个条目不作截断后盲选。一个有效候选可采用；没有候选、多个候选或搜索不完整时，展示结果，才让客户指定一次源码根目录或从选定副本重新安装。不能声称任意移动位置都能自动找到。
4. `source-resolved` 才可采用返回的 `source` 和 `skill`。重新完整读取该源码 SKILL.md，后续 references、assets 与创建/请求工具统一从同一 `source` 读取。`installedCopyMatchesSource=false` 表示本地安装副本与源码不同，本轮采用已核验的本地源码内容并说明实际版本；不混用旧缓存，也不自动执行 git pull、切分支或选择“版本号最大”的另一副本。需要更新安装副本时复用用户已给的安装/更新授权，从此源码运行安装命令。
5. 工具命令的工作目录设为返回的源码根目录；接入目标仍是用户当前客户项目，绝不能把规范仓库作为业务修改目标。记录源码路径、版本、来源类型，与客户项目根目录分别保存。调用创建工具前再次核验，防止中途切分支、移走仓库或文件缺失；出现变化先重新加载相应规范，已确认内容发生实质变化时重走受影响门禁。

这里只读取 Skill 自身和规范仓库标识/文件，不读取客户配置或执行云操作，可以在第一门禁提问前完成。**它不是新门禁，也不代表任何门禁通过**；定位完成后先判断客户意图。首次接入在第一门禁先确认免费环境；选择版本维护时从已确认的目标发布流开始查当前状态。

源码未找到时可以用已安装且完整的指引完成环境开通说明，但依赖源码的资源创建、请求生成与实施必须停留准备状态，先解决源码定位。普通用户提示词只需 `$bifang-public-services-onboarding 请按门禁帮我接入本项目。`
