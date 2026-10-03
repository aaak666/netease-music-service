/**
 * Meting 兼容格式组装（播放器策略层，无 IO）
 */
function toMetingItem(s, baseUrl) {
  return {
    name: s.name,
    artist: s.artist,
    url: `${baseUrl}?type=url&id=${s.id}`,
    pic: `${baseUrl}?type=pic&id=${s.id}`,
    lrc: `${baseUrl}?type=lrc&id=${s.id}`,
  }
}

function formatSongs(songs, baseUrl) {
  return songs.map((s) => toMetingItem(s, baseUrl))
}

module.exports = { toMetingItem, formatSongs }
