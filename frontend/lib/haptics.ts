/**
 * 轻触反馈。安卓 Chrome 走 Vibration API；iOS Safari 至今不支持
 * （`navigator.vibrate` 是 undefined），那里就是静默无反馈，不报错也不用兜底。
 * 必须在用户手势的事件处理里调用，否则浏览器会忽略。
 */
export function haptic(ms: number = 10) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // 某些内嵌浏览器会直接抛，忽略即可
  }
}

/** 删除这类破坏性操作用稍重一点的两下 */
export function hapticStrong() {
  try {
    navigator.vibrate?.([12, 30, 12]);
  } catch {}
}
