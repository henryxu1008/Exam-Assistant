/** User-facing local persistence state. No answer data, raw exceptions or account identifiers. */
const isStorageReadable = (status = {}) => status.state !== 'read_error' && !status.readError
function storageStatusView(status = {}) {
  if (status.commitUncertain) return { tone: 'error', title: '保存结果待核对', detail: '请先关闭并重新打开小程序，再核对作答记录。', retry: false }
  if (!isStorageReadable(status)) return { tone: 'error', title: '学习档案暂时无法读取', detail: '请重试读取。若仍失败，请保留当前数据并联系支持，避免清空或重新安装。', retry: true }
  if (status.state === 'write_error') return { tone: 'error', title: '有操作保存失败', detail: '请重试保存；未保存的作答需返回原题重新提交。清空数据不能代替恢复。', retry: true }
  if (status.migrationDeferred) return { tone: 'warning', title: '存储优化已延期', detail: status.migrationError === 'LOCAL_CAPACITY_INSUFFICIENT'
    ? '本次数据已按原格式保存，迁移所需空间不足。请保留学习数据，稍后重试或联系支持。'
    : '本次数据已按原格式保存，暂时无法完成存储优化，可稍后重试。', retry: true }
  if (status.cleanupPending) return { tone: 'warning', title: '存储清理待完成', detail: '当前检查点已保存，部分旧文件尚未清理，可重试清理。', retry: true }
  return { tone: 'ready', title: '本地检查点可用', detail: '本地保存状态与云端同步状态分别确认。', retry: false }
}
module.exports = { storageStatusView, isStorageReadable }
