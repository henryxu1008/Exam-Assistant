/**
 * scripts/check-shared-sync.js
 * 校验「共享模块的部署副本」与 shared/ 下的源文件逐字节一致。
 *
 * 为什么需要：云函数按目录独立上传，无法 require 父级目录的代码，
 * 所以 shared/ 中的模块必须在每个 cloudfunctions/<fn>/ 目录放一份副本。
 * 副本一旦与源文件漂移，端上与云端就会执行不同的合并 / 鉴权语义，
 * 而且这类问题在单端测试里看不出来（本轮评审的 P1 正是这一类）。
 * 因此在 CI 中阻断漂移：改了源文件就必须同步副本。
 *
 * 若提示不一致，重新复制即可：
 *   Copy-Item shared\auth.js cloudfunctions\bankSync\auth.js -Force
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ROOT = path.resolve(__dirname, '..')

/** [源文件, ...部署副本] */
const MAPPINGS = [
  ['shared/stats-merge.js', 'cloudfunctions/studySync/stats-merge.js'],
  // studySync/auth.js 此前也是逐字节一致的副本，却没被登记，
  // 于是「源文件改了、这份漏同步」完全不可见——把登记表与实际一致的情况对齐
  [
    'shared/auth.js',
    'cloudfunctions/bankSync/auth.js',
    'cloudfunctions/initConfig/auth.js',
    'cloudfunctions/studySync/auth.js'
  ],
  // 「读失败不得当成不存在」的判定必须所有云函数一致：
  // initConfig 就是照抄了 studySync 的旧实现才带着同一个缺陷。
  [
    'shared/db-error.js',
    'cloudfunctions/studySync/db-error.js',
    'cloudfunctions/initConfig/db-error.js',
    'cloudfunctions/bankSync/db-error.js',
    'cloudfunctions/userProfile/db-error.js'
  ]
]

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

const errors = []

MAPPINGS.forEach((mapping) => {
  const src = mapping[0]
  const copies = mapping.slice(1)
  const srcPath = path.join(ROOT, src)

  if (!fs.existsSync(srcPath)) {
    errors.push(`缺少共享源文件: ${src}`)
    return
  }
  const srcHash = sha256(srcPath)

  copies.forEach((rel) => {
    const p = path.join(ROOT, rel)
    if (!fs.existsSync(p)) {
      errors.push(`缺少部署副本: ${rel}（源文件 ${src}）`)
      return
    }
    if (sha256(p) !== srcHash) {
      errors.push(`部署副本已漂移: ${rel} 与 ${src} 不一致`)
    }
  })
})

if (errors.length) {
  console.error('Shared sync failed:\n' + errors.join('\n'))
  process.exit(1)
}
console.log('Shared sync OK: 云函数部署副本与 shared/ 源一致')
