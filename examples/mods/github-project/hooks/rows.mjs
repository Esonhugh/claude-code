export default function GithubRows(sections, { elements: { Box, Text, Link } }) {
  if (!Array.isArray(sections)) return Text({ children: 'GitHub' })
  const rows = sections[0]?.tableRows
  if (!Array.isArray(rows)) {
    return Box({ flexDirection: 'column', gap: 1, children: sections.map(({ title, empty, rows }) =>
      Box({ flexDirection: 'column', children: [
        Text({ bold: true, children: title }),
        ...(rows.length ? rows.map(({ number, title, label, url }) =>
          Link({ href: url, label: `#${number} ${title} · ${label}` })) : [Text({ dimColor: true, children: empty })]),
      ] })) })
  }
  return Box({ children: rows.map(({ issue, pulls, title }) => Box({ children: [
    Box({ children: issue ? [Link({ href: issue })] : [] }),
    Box({ children: pulls.map(href => Link({ href })) }),
    Text({ children: title }),
  ] })) })
}
