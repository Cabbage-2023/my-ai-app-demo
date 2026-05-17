import 'dotenv/config'

const QDRANT_URL = process.env.QDRANT_URL!

/**
 * Search for content that might relate to specific game pairs
 * to understand what comparison data we have available
 */
async function main() {
  // Search for CLANNAD reviews mentioning "催泪"
  const res1 = await fetch(`${QDRANT_URL}/collections/resources/points/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vector: Array(1024).fill(0).map(() => Math.random() * 2 - 1),
      limit: 5,
      with_payload: true,
      filter: { must: [
        { key: 'gameName', match: { value: 'CLANNAD' } },
        { key: 'type', match: { value: 'review' } }
      ]}
    })
  })
  const data1 = await res1.json()
  console.log('=== CLANNAD reviews ===')
  for (const p of data1.result) {
    console.log(`  score=${p.score.toFixed(3)} ${(p.payload.content || '').replace(/\n/g,' ').substring(0, 150)}`)
  }

  // Search for white album 2 reviews
  for (const gn of ['白色相簿2 序章', '白色相簿2 终章', '白色相簿2 mini After Story']) {
    const res = await fetch(`${QDRANT_URL}/collections/resources/points/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vector: Array(1024).fill(0).map(() => Math.random() * 2 - 1),
        limit: 3, with_payload: true,
        filter: { must: [{ key: 'gameName', match: { value: gn } }] }
      })
    })
    const data = await res.json()
    console.log(`\n=== ${gn} ===`)
    for (const p of data.result) {
      console.log(`  type=${p.payload.type} ${(p.payload.content || '').replace(/\n/g,' ').substring(0, 120)}`)
    }
  }
}
main().catch(console.error)
