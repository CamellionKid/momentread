export const paragraphs = [
  "人们在日常生活中接触到的事物纷繁复杂，感官经验提供了丰富的材料，但这些材料本身并不等同于认识。经验告诉我们有什么，却不必然说明我们如何理解它。要形成稳定的认识，需要在经验之上进行概念的整理与判断。",
  "在学习和思考的过程中，我们常常会遇到一些相近的概念，它们在词语上相似，在含义上却有重要的区别。如果不能加以区分，很容易在讨论中混淆问题，导致结论模糊。因此，澄清概念之间的差异是建立清晰思考的基础。",
  "进一步说，认识不仅依赖于经验的积累，也需要主体的主动组织。我们会根据已有的概念框架，对经验材料进行选择、比较和综合，从而形成某种有结构的理解。这一过程并非简单的被动接受，而是包含了规则、方法与视角。",
  "因此，经验与认识并不是对立的两端，而是相互关联的环节。经验提供了内容，认识赋予其秩序。只有在两者的结合中，我们才能逐步接近更为普遍和稳定的知识。",
];
export const books = [
  {
    id: "kant",
    title: "纯粹理性批判",
    author: "伊曼努尔·康德",
    chapter: "绪论 · 经验与认识",
    progress: 12,
    discussions: 3,
  },
  {
    id: "groundwork",
    title: "道德形而上学奠基",
    author: "伊曼努尔·康德",
    chapter: "序言",
    progress: 4,
    discussions: 0,
  },
  {
    id: "liberty",
    title: "论自由",
    author: "约翰·斯图亚特·密尔",
    chapter: "第一章 · 引论",
    progress: 0,
    discussions: 0,
  },
];
const base = {
  messages: [],
  draft: "",
  returned: false,
  summary: null,
  summaryVersion: 0,
  needsUpdate: false,
  receipts: [],
  scroll: 0,
};
export function initialNodes() {
  return [
    {
      ...base,
      id: "intro",
      parent: null,
      title: "导读与背景",
      kind: "passage",
      excerpt: paragraphs[0],
      body: [
        [
          "从哪里开始",
          "先辨认作者试图回答的问题，再进入具体概念。这里的文字仅用于演示阅读流程。",
        ],
      ],
    },
    {
      ...base,
      id: "passage",
      parent: null,
      title: "段落解析",
      kind: "passage",
      excerpt: paragraphs[1],
      body: [
        [
          "这段在说什么",
          "相近的词不一定具有相同含义。理解一段论证，需要把概念放回它所处的语境。",
        ],
        [
          "内容拆解",
          "先区分经验提供的材料，再看认识如何组织材料。“先验”与“先天”可以分别展开讨论，不必在同一段解释中一次讲清。",
        ],
        [
          "举个例子",
          "看到许多树是经验；辨认它们为什么都可以被称为“树”，还涉及概念与判断。这个例子用于说明区别，并不是原著引文。",
        ],
      ],
    },
    {
      ...base,
      id: "transcendental",
      parent: "passage",
      title: "先验",
      kind: "concept",
      excerpt: "需要在经验之上进行概念的整理与判断。",
      body: [
        [
          "在当前讨论中",
          "“先验”在这里引导我们追问：经验与认识何以可能？这与仅仅列举经验内容不同。具体用法还需要回到原著核对。",
        ],
        [
          "与相近概念区分",
          "“先天”与“先验”不能只因为都带有“先”字就混为一谈。前者关心知识与经验的关系，后者关心认识的可能条件。",
        ],
        [
          "继续澄清",
          "判断如何把概念与对象联系起来？这是可以从当前讨论继续展开的子问题。",
        ],
      ],
    },
    {
      ...base,
      id: "judgment",
      parent: "transcendental",
      title: "判断",
      kind: "concept",
      excerpt: "在“先验”的讨论中，继续澄清“判断”。",
      body: [
        [
          "在当前讨论中",
          "“判断”之所以在这里被提出，是因为仅有概念的区分还不够。我们需要进一步说明，概念如何通过判断形成有意义的连接，从而在思维中确立某种确定的关系。这有助于理解先验认识的结构是如何运作的。",
        ],
        [
          "举个例子",
          "例如，当我们说“这是一棵树”时，就在把概念“树”下对一个经验对象进行了判断。判断不仅联结了概念与对象，也表明了主体在思维中所持的肯定或否定态度。",
        ],
        [
          "回到上一级",
          "从这个角度看，判断便是先验讨论中不可或缺的环节。它帮助我们理解，概念如何在经验之外仍然具有普遍性和必然性。",
        ],
      ],
    },
    {
      ...base,
      id: "category",
      parent: "transcendental",
      title: "范畴",
      kind: "concept",
      excerpt: "概念如何参与认识的组织？",
      body: [
        [
          "在当前讨论中",
          "这里先把“范畴”作为需要核对的认识形式来讨论。具体分类与原著术语保留为待核，不把演示解释当作定论。",
        ],
      ],
    },
    {
      ...base,
      id: "apriori",
      parent: "passage",
      title: "先天",
      kind: "concept",
      excerpt: "认识是否都来自经验？",
      body: [
        [
          "在当前讨论中",
          "“先天”并不简单等于出生前已经知道。我们需要讨论某种认识的根据是否依赖特定经验。",
        ],
        [
          "与先验区分",
          "这场讨论与“先验”共享来源段落，但保留自己的追问、草稿和小结。",
        ],
      ],
    },
    {
      ...base,
      id: "structure",
      parent: null,
      title: "论证的结构",
      kind: "passage",
      excerpt: paragraphs[2],
      body: [
        [
          "沿着阅读继续",
          "这个节点记录下一次段落解析。点击只切换讨论，不改变左侧的阅读位置。",
        ],
      ],
    },
    {
      ...base,
      id: "review",
      parent: null,
      title: "回顾与问题",
      kind: "passage",
      excerpt: paragraphs[3],
      body: [
        [
          "暂时留一个问题",
          "如果经验提供内容，认识的组织方式又从哪里来？可以继续阅读，也可以稍后回来。",
        ],
      ],
    },
  ];
}
export function ancestors(nodes, id) {
  const out = [];
  let cur = nodes.find((n) => n.id === id);
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    out.unshift(cur);
    seen.add(cur.id);
    cur = nodes.find((n) => n.id === cur.parent);
  }
  return out;
}
export function layoutTree(nodes, collapsed, activeId) {
  const activePath = new Set(ancestors(nodes, activeId).map((n) => n.id));
  let cursor = 86;
  const positions = [];
  function walk(n, depth) {
    const children = nodes.filter((c) => c.parent === n.id);
    const hide = collapsed.has(n.id) && !activePath.has(n.id);
    let y;
    if (children.length && !hide) {
      const kids = children.map((c) => walk(c, depth + 1));
      y = (kids[0] + kids[kids.length - 1]) / 2;
    } else {
      y = cursor;
      cursor += 138;
    }
    positions.push({
      ...n,
      x: 32 + depth * 69,
      y,
      depth,
      folded: hide && children.length > 0,
    });
    return y;
  }
  nodes.filter((n) => !n.parent).forEach((n) => walk(n, 0));
  return {
    positions,
    height: Math.max(850, cursor + 50),
    width: Math.max(230, ...positions.map((p) => p.x + 48)),
  };
}
