/**
 * `.nboard` / `.nestmind` 兼容层单测
 */

import assert from "node:assert/strict"
import {
  cardNumber,
  cardText,
  createBoardRefCard,
  createImageCard,
  createLinkCard,
  createNBoard,
  createNoteCard,
  createNoteRefCard,
  nextZ,
  parseNBoard,
  removeCard,
  stringifyNBoard,
  touchNBoard,
} from "../src/core/format/nboard"
import {
  addMindChild,
  createNestMind,
  flattenMind,
  mindChildren,
  parseNestMind,
  removeMindNode,
  stringifyNestMind,
  touchNestMind,
} from "../src/core/format/nestmind"
import {
  generateCanvasFromContent,
  generateNBoardFromContent,
  serializeCanvas,
} from "../src/editor/canvasGenerator"

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e) {
    failed++
    console.error(`FAIL  ${name}`)
    console.error(e instanceof Error ? e.message : e)
  }
}

const NBOARD_FIXTURE = JSON.stringify(
  {
    spec: "nestboard/1",
    version: 1,
    revision: 7,
    meta: {
      id: "nb_01M6N5Z7NN00P3D7GN",
      title: "Home",
      icon: null,
      createdAt: "2026-11-05T06:22:35.700Z",
      updatedAt: "2026-11-05T06:31:47.252Z",
      parent: null,
      tags: [],
      aliases: [],
    },
    view: { x: 0, y: 0, zoom: 1, background: "dots" },
    settings: { snapToGrid: true, gridSize: 16, defaultCardColor: "1", readOnly: false },
    columns: [
      {
        id: "col_01M6N5Z7NM0VE872GN",
        title: "Unsorted",
        x: 0,
        y: 0,
        width: 320,
        height: 500,
        collapsed: false,
        color: "#ffffff",
        z: 1,
      },
    ],
    cards: [
      {
        id: "c_01M6N5Z7T30MHQREVE",
        type: "noteRef",
        x: 12,
        y: 46,
        width: 296,
        height: 160,
        z: 2,
        columnId: "col_01M6N5Z7NM0VE872GN",
        order: 0,
        color: "1",
        accent: null,
        locked: false,
        showTitle: false,
        title: "",
        presentStep: null,
        content: {
          path: "未命名思维导图.md",
          subpath: null,
          mode: "summary",
          excerptLines: 6,
        },
        customKey: "must-survive",
      },
    ],
    edges: [],
    groups: [],
    customTopLevel: { hello: "world" },
  },
  null,
  2,
)

const NESTMIND_FIXTURE = JSON.stringify(
  {
    spec: "nestmind/1",
    version: 1,
    revision: 19,
    meta: {
      id: "nm_01M6N67Y9S1HP9KDJW",
      title: "未命名脑图",
      createdAt: "2026-11-05T06:27:21.017Z",
      updatedAt: "2026-11-05T06:31:07.202Z",
    },
    view: {
      x: 609.28,
      y: 402,
      zoom: 0.9904,
      background: "dots",
      outline: false,
      structure: "logic-right",
    },
    rootId: "n_root",
    nodes: [
      { id: "n_root", text: "你好", note: "", parentId: null, order: 0 },
      { id: "n_a", text: "分支 A", note: "内容", parentId: "n_root", order: 0 },
      { id: "n_b", text: "分支 B", note: "", parentId: "n_root", order: 1 },
      { id: "n_a1", text: "A1", note: "", parentId: "n_a", order: 0 },
      {
        id: "n_free",
        text: "悬浮节点",
        note: "",
        parentId: null,
        order: 2,
        free: { x: -112.89, y: 80.5 },
      },
    ],
    links: [{ id: "l_1", from: "n_a", to: "n_b", arrow: "end", label: "关联" }],
  },
  null,
  2,
)

console.log("nboard.ts")

test("parse：保留未知字段与卡片内容", () => {
  const r = parseNBoard(NBOARD_FIXTURE)
  assert.equal(r.ok, true)
  if (!r.ok) return
  const board = r.value
  assert.equal(board.meta.title, "Home")
  assert.equal(board.cards.length, 1)
  assert.equal((board as any).customTopLevel.hello, "world")
  assert.equal((board.cards[0] as any).customKey, "must-survive")
  assert.equal(cardText(board.cards[0], "path"), "未命名思维导图.md")
})

test("roundtrip：解析→序列化→解析 深度相等", () => {
  const first = parseNBoard(NBOARD_FIXTURE)
  assert.equal(first.ok, true)
  if (!first.ok) return
  const text = stringifyNBoard(first.value)
  const second = parseNBoard(text)
  assert.equal(second.ok, true)
  if (!second.ok) return
  assert.deepEqual(second.value, first.value)
  assert.ok(text.endsWith("\n"))
})

test("parse：错误 spec / 坏 JSON 返回错误", () => {
  const badJson = parseNBoard("{")
  assert.equal(badJson.ok, false)
  const badSpec = parseNBoard('{"spec":"other/1","cards":[]}')
  assert.equal(badSpec.ok, false)
  const noCards = parseNBoard('{"spec":"nestboard/1"}')
  assert.equal(noCards.ok, false)
})

test("create：空白板 + 各类卡片 + z 序", () => {
  const board = createNBoard({ title: "测试板" })
  assert.equal(board.cards.length, 0)
  assert.equal(board.meta.title, "测试板")

  const note = createNoteCard(board, "# 你好", { x: 10, y: 20 })
  board.cards.push(note)
  const ref = createNoteRefCard(board, "笔记.md", { x: 300, y: 20 })
  board.cards.push(ref)
  const link = createLinkCard(board, "https://example.com", "示例", { x: 0, y: 300 })
  board.cards.push(link)
  const image = createImageCard(board, "img/a.png", { x: 300, y: 300 })
  board.cards.push(image)
  const boardRef = createBoardRefCard(board, "Boards/Home.nboard", { x: 700, y: 20 })
  board.cards.push(boardRef)

  assert.equal(nextZ(board), 6)
  assert.equal(cardText(note, "md"), "# 你好")
  assert.equal(cardText(ref, "path"), "笔记.md")
  assert.equal(cardNumber(ref, "excerptLines"), 6)
  assert.equal(cardText(boardRef, "path"), "Boards/Home.nboard")

  const text = stringifyNBoard(board)
  const r = parseNBoard(text)
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.value.cards.length, 5)
})

test("removeCard：同时清理连线与编组成员", () => {
  const board = createNBoard()
  const a = createNoteCard(board, "A")
  const b = createNoteCard(board, "B")
  board.cards.push(a, b)
  board.edges.push({
    id: "e1",
    from: { cardId: a.id, side: "right" },
    to: { cardId: b.id, side: null },
  })
  board.groups.push({ id: "g1", cardIds: [a.id, b.id], label: "组" })
  removeCard(board, a.id)
  assert.equal(board.cards.length, 1)
  assert.equal(board.edges.length, 0)
  assert.deepEqual(board.groups[0].cardIds, [b.id])
})

test("touchNBoard 递增 revision 并更新时间", () => {
  const board = createNBoard()
  const before = board.revision
  touchNBoard(board)
  assert.equal(board.revision, before + 1)
  assert.ok(board.meta.updatedAt.length > 0)
})

test("generateNBoardFromContent 保留大纲卡片、布局和连线", () => {
  const markdown = [
    "# 测试剧本",
    "",
    "## 第一场",
    "",
    "### 镜头 1",
    "",
    "#s",
    "推进剧情",
    "",
    "### 镜头 2",
    "",
    "#e",
    "情绪收束",
    "",
  ].join("\n")
  const canvas = generateCanvasFromContent(markdown)
  const serializedCanvas = JSON.parse(serializeCanvas(canvas)) as typeof canvas
  assert.equal(serializedCanvas.nodes.length, 4)
  assert.equal(serializedCanvas.edges.length, 3)
  assert.deepEqual(serializedCanvas, canvas)
  assert.deepEqual(
    serializedCanvas.edges.map((edge) => [edge.fromSide, edge.toSide]),
    [["bottom", "top"], ["right", "left"], ["right", "left"]],
  )

  const board = generateNBoardFromContent(markdown, undefined, {
    title: "测试无限画布",
    gridSize: 24,
  })

  assert.equal(board.spec, "nestboard/1")
  assert.equal(board.meta.title, "测试无限画布")
  assert.equal(board.settings.gridSize, 24)
  assert.equal(board.cards.length, canvas.nodes.length)
  assert.equal(board.edges.length, canvas.edges.length)

  const cardIds = new Set<string>()
  board.cards.forEach((card, index) => {
    const node = canvas.nodes[index]
    cardIds.add(card.id)
    assert.equal(card.type, "note")
    assert.equal(card.title, "")
    assert.equal(card.showTitle, false)
    assert.equal(card.content.editorMode, "preview")
    assert.equal(typeof card.content.md, "string")
    assert.equal(card.x, node.x)
    assert.equal(card.y, node.y)
    assert.equal(card.width, node.width)
    assert.equal(card.height, node.height)
    assert.equal(card.color, node.color)
  })
  assert.match(String(board.cards[2].content.md), /\*\*镜头 1\*\*/)
  assert.match(String(board.cards[2].content.md), /推进剧情/)
  assert.match(String(board.cards[3].content.md), /情绪收束/)

  board.edges.forEach((edge, index) => {
    assert.ok(cardIds.has(edge.from.cardId))
    assert.ok(cardIds.has(edge.to.cardId))
    assert.equal(edge.from.side, canvas.edges[index].fromSide ?? null)
    assert.equal(edge.to.side, canvas.edges[index].toSide ?? null)
    assert.equal(edge.fromEnd, canvas.edges[index].fromEnd)
    assert.equal(edge.toEnd, canvas.edges[index].toEnd)
  })

  const parsed = parseNBoard(stringifyNBoard(board))
  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    assert.equal(parsed.value.cards.length, board.cards.length)
    assert.equal(parsed.value.edges.length, board.edges.length)
    assert.deepEqual(
      parsed.value.edges.map((edge) => ({ from: edge.from, to: edge.to })),
      board.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    )
  }
})

test("空白原生白板与 NBoard 使用不同的序列化产物", () => {
  const canvas = JSON.parse(serializeCanvas({ nodes: [], edges: [] }))
  assert.deepEqual(canvas, { nodes: [], edges: [] })

  const board = generateNBoardFromContent("# 测试剧本")
  assert.equal(board.spec, "nestboard/1")
  assert.equal("nodes" in board, false)
  assert.ok(board.cards.length > 0)
})

console.log("nestmind.ts")

test("parse：节点/关联线/悬浮节点保留", () => {
  const r = parseNestMind(NESTMIND_FIXTURE)
  assert.equal(r.ok, true)
  if (!r.ok) return
  const mind = r.value
  assert.equal(mind.rootId, "n_root")
  assert.equal(mind.nodes.length, 5)
  assert.equal(mind.nodes.find((n) => n.id === "n_free")?.free?.x, -112.89)
  assert.equal(mind.links?.length, 1)
})

test("roundtrip：解析→序列化→解析 深度相等", () => {
  const first = parseNestMind(NESTMIND_FIXTURE)
  assert.equal(first.ok, true)
  if (!first.ok) return
  const second = parseNestMind(stringifyNestMind(first.value))
  assert.equal(second.ok, true)
  if (!second.ok) return
  assert.deepEqual(second.value, first.value)
})

test("createNestMind / children / flatten", () => {
  const mind = createNestMind("演示", "中心")
  assert.equal(mind.nodes.length, 1)
  const a = addMindChild(mind, mind.rootId, "A")
  const b = addMindChild(mind, mind.rootId, "B")
  const a1 = addMindChild(mind, a.id, "A1")
  assert.deepEqual(
    mindChildren(mind, mind.rootId).map((n) => n.text),
    ["A", "B"],
  )
  assert.deepEqual(
    flattenMind(mind).map((n) => n.text),
    ["中心", "A", "A1", "B"],
  )
  assert.equal(a1.parentId, a.id)
  assert.equal(b.order, 1)
})

test("removeMindNode：删除整棵子树与相关关联线", () => {
  const mind = createNestMind()
  const a = addMindChild(mind, mind.rootId, "A")
  const a1 = addMindChild(mind, a.id, "A1")
  const b = addMindChild(mind, mind.rootId, "B")
  mind.links = [{ id: "l", from: a1.id, to: b.id }]
  removeMindNode(mind, a.id)
  assert.equal(mind.nodes.length, 2)
  assert.equal(mind.nodes.find((n) => n.id === a1.id), undefined)
  assert.equal(mind.links?.length, 0)
  // 根节点不可删
  removeMindNode(mind, mind.rootId)
  assert.equal(mind.nodes.some((n) => n.id === mind.rootId), true)
})

test("touchNestMind 递增 revision", () => {
  const mind = createNestMind()
  const before = mind.revision
  touchNestMind(mind)
  assert.equal(mind.revision, before + 1)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
