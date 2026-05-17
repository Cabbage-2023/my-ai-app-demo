import 'dotenv/config'

const QDRANT_URL = process.env.QDRANT_URL!

async function main() {
  console.log('Connecting to:', QDRANT_URL)

  // Page 1
  const scroll1 = await fetch(`${QDRANT_URL}/collections/resources/points/scroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 10000, with_payload: ['gameName', 'type', 'charName'], with_vector: false }),
  })
  const data1 = await scroll1.json()
  const points1 = data1.result.points
  console.log('Page 1:', points1.length)

  // Page 2 if needed
  let points2: any[] = []
  if (data1.result.next_page_offset) {
    const scroll2 = await fetch(`${QDRANT_URL}/collections/resources/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 10000, offset: data1.result.next_page_offset, with_payload: ['gameName', 'type', 'charName'], with_vector: false }),
    })
    const data2 = await scroll2.json()
    points2 = data2.result.points
    console.log('Page 2:', points2.length)
  }

  const allPoints = [...points1, ...points2]
  const gameNames = new Set<string>()
  const charNames = new Set<string>()
  const typeCount: Record<string, number> = {}

  for (const p of allPoints) {
    const t = p.payload.type
    typeCount[t] = (typeCount[t] || 0) + 1
    if (t === 'game_intro' && p.payload.gameName) gameNames.add(p.payload.gameName)
    if (t === 'character' && p.payload.charName) charNames.add(p.payload.charName)
  }

  console.log('\n=== Type Counts ===')
  console.log(JSON.stringify(typeCount, null, 2))

  console.log(`\n=== Game Names (${gameNames.size}) ===`)
  const games = [...gameNames].sort()
  games.forEach(g => console.log(`  "${g}",`))

  console.log(`\n=== Character Names (${charNames.size}) ===`)
  const chars = [...charNames].sort()
  chars.forEach(c => console.log(`  "${c}",`))
}

main().catch(console.error)
