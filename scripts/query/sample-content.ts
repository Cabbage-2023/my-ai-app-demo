import 'dotenv/config'

const QDRANT_URL = process.env.QDRANT_URL!

async function main() {
  const types = ['game_intro', 'comment', 'review', 'char_review', 'character']
  for (const type of types) {
    const randomVec = new Array(1024).fill(0).map(() => Math.random() * 2 - 1)
    const res = await fetch(`${QDRANT_URL}/collections/resources/points/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vector: randomVec, limit: 4, with_payload: true,
        filter: { must: [{ key: 'type', match: { value: type } }] }
      })
    })
    const data = await res.json()
    console.log(`\n=== Type: ${type} ===`)
    for (const p of data.result) {
      const c = (p.payload.content || '').replace(/\n/g, ' ').substring(0, 150)
      console.log(`  [${p.payload.gameName || '-'}][${p.payload.charName || '-'}] ${c}`)
    }
  }
}
main().catch(console.error)
