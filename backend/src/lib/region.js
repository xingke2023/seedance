'use strict'

// 只用国内站开关。开了之后国际站 (videogen.fidelityai.cn 登录 + 火山方舟直连 ARK_API_KEY)
// 的所有代码路径一律不可用/被强制改写成国内站 (vidgen.fidelityai.cn + FIDELITY_CN_API_SK)。
// 选择做成单一 env 开关而不是每个功能各自一个开关，是因为国际站目前只有部分功能有国内站
// 等价物（视频生成、素材分组、真人验证都有；Token/资源密钥管理没有）——开这个开关就是明确
// 表示「没有国内站等价物的功能可以直接不可用」，不需要逐条精细控制。
const CN_ONLY = String(process.env.FIDELITY_CN_ONLY || '').toLowerCase() === 'true'

module.exports = { CN_ONLY }
