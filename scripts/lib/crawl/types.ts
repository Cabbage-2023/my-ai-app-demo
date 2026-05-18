export interface GameListItem {
  id: number
  name: string
  nameJP: string
  rank: number
  score: number
  ratingCount: number
  coverUrl: string
}

export interface GameDetail {
  id: number
  name: string
  nameCN: string
  summary: string
  infobox: { key: string; value: string }[]
  tags: string[]
  score: number
  rank: number
  ratingCount: number
  coverUrl: string
  nsfw: boolean
}

export interface Comment {
  userId: string
  userName: string
  text: string
  score: number // 1-10
  status: string // 玩过 / 想玩 / 搁置 / 抛弃
  date: string
}

export interface Review {
  id: number
  title: string
  summary: string
  fullContent?: string  // 补爬全文后填充
  author: string
  replyCount: number
  date: string
}

export interface CharacterInfo {
  id: number
  name: string
  nameCN: string
  summary: string
  gender: string
  birthYear: number | null
  birthMon: number | null
  birthDay: number | null
  imageUrl: string
  cvName: string
  subjectId: number // 所属游戏 ID
  relation: string  // 主角 / 配角 / 空
}

export interface CrawlResult {
  game: GameDetail
  comments: Comment[]
  reviews: Review[]
  characters: CharacterInfo[]
}
