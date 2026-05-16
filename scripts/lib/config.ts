import 'dotenv/config'

export const BANGUMI_COOKIE_SEC_ID = process.env.BANGUMI_COOKIE_SEC_ID ?? ''
export const BANGUMI_COOKIE_SID = process.env.BANGUMI_COOKIE_SID ?? ''
export const BANGUMI_USER_ID = process.env.BANGUMI_USER_ID ?? ''
export const BANGUMI_API_TOKEN = process.env.BANGUMI_API_TOKEN ?? ''

export const BASE_URL = 'https://bangumi.tv'
export const API_BASE_URL = 'https://api.bgm.tv'

export const REQUEST_DELAY_MS = 300 // 每次请求间隔 300ms（Bangumi 实测可承受）
export const MAX_RETRIES = 3

export const COOKIE_STRING = `chii_sec_id=${encodeURIComponent(BANGUMI_COOKIE_SEC_ID)}; chii_sid=${BANGUMI_COOKIE_SID}`

/** 排行榜页数：每页约 24 条，前 300 名需要前 13 页 */
export const RANK_PAGES = 13

/** 筛选条件：仅保留评分人数 > 500 的条目 */
export const MIN_RATING_COUNT = 500
