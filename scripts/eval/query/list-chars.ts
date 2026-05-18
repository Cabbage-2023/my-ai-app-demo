import 'dotenv/config'

const QDRANT_URL = process.env.QDRANT_URL!

async function main() {
  const scroll = await fetch(`${QDRANT_URL}/collections/resources/points/scroll`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      limit: 5000,
      with_payload: ['charName', 'gameName'],
      with_vector: false,
      filter: { must: [{ key: 'type', match: { value: 'character' } }] }
    })
  })
  const data = await scroll.json()
  const points = data.result.points
  console.log('Total character points:', points.length)

  const charMap = new Map<string, Set<string>>()
  for (const p of points) {
    const name = p.payload.charName
    if (!name) continue
    if (!charMap.has(name)) charMap.set(name, new Set())
    charMap.get(name)!.add(p.payload.gameName || '')
  }

  const cnChars = [...charMap.entries()].filter(([name]) => /[一-鿿]/.test(name))
  cnChars.sort((a, b) => a[0].localeCompare(b[0]))
  console.log('\nChinese-named Characters (' + cnChars.length + '):')
  for (const [name, games] of cnChars) {
    console.log(`  "${name}"  [${[...games].join(', ')}]`)
  }

  const jpChars = [...charMap.entries()].filter(([name]) => !/[一-鿿]/.test(name))
  jpChars.sort((a, b) => a[0].localeCompare(b[0]))
  console.log('\nJapanese-named Characters - sample 80:')
  for (const [name, games] of jpChars.slice(0, 80)) {
    console.log(`  "${name}"  [${[...games].join(', ')}]`)
  }
  console.log(`  ... (${jpChars.length - 80} more)`)
}
main().catch(console.error)
