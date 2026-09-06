/**
 * §4.2 AI 智能排座 —— 约束解析与确定性落座。
 *
 * 设计：AI 只负责把教师自然语言翻译成结构化约束，具体"谁坐哪"由确定性算法
 * 完成（可测、可复现、不烧 token）。
 *
 * 输出结构（AI 需返回 JSON）：
 * {
 *   "preferFront": ["张三"],      // 希望靠前的学生（近视/身高矮），按优先级排前
 *   "avoidFront":  ["李四"],      // 希望靠后的学生
 *   "pairs":       [["张三","王五"]], // 强制邻座配对（可选）
 *   "spread":      false,          // 若 true：姓名打散不与同班/同伴相邻
 *   "strategy":    "class"         // "class"|"activity"（按活动分组）| null
 * }
 */

// ── Types ──────────────────────────────────────────────

export interface SmartAssignInstruction {
  lessonId: string;
  labIds?: string[];
  labId?: string;            // 单机房兼容
  activityId?: string;
  instruction: string;       // 教师自然语言，如"让近视的张小明坐前面，李雷别坐第一排"
}

export interface SmartConstraint {
  preferFront: string[];
  avoidFront: string[];
  pairs: Array<[string, string]>;
  spread: boolean;
  strategy: 'class' | 'activity' | null;
}

export interface StudentRow {
  id: string;
  name: string;
  group_id?: string;
}

// ── Prompt 构造 ────────────────────────────────────────

export function buildSmartPrompt(
  students: StudentRow[],
  instruction: string,
): { prompt: string; systemInstruction: string } {
  const roster = students
    .map(s => `${s.id}|${s.name}`)
    .join('\n');
  const systemInstruction = [
    '你是座位编排助手。教师给出座位安排要求，你只输出 JSON，不要输出任何其他文字/解释。',
    'JSON 格式：',
    '{"preferFront":["学生姓名"],"avoidFront":["学生姓名"],"pairs":[["姓名A","姓名B"]],"spread":false,"strategy":null}',
    '规则：',
    '- preferFront/avoidFront 只填学生名单里真实存在的姓名，找不到就空数组。',
    '- strategy 仅当要求"按小组/活动分组坐"时为 "activity"，其余为 null。',
    '- pairs 用于明确要求两人邻座。',
  ].join('\n');
  const prompt = [
    `学生名单（ID|姓名）：\n${roster || '（空）'}`,
    '',
    `教师要求：${instruction}`,
    '',
    '输出：',
  ].join('\n');
  return { prompt, systemInstruction };
}

// ── AI 输出解析（容错 JSON） ──────────────────────────

export function parseSmartConstraint(raw: string): SmartConstraint {
  const fallback: SmartConstraint = { preferFront: [], avoidFront: [], pairs: [], spread: false, strategy: null };
  if (!raw) return fallback;
  let text = raw.trim();
  // 剥离 markdown 代码围栏
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  // 截取第一个 { 到最后一个 }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return fallback;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    return {
      preferFront: Array.isArray(obj.preferFront) ? obj.preferFront.map(String) : [],
      avoidFront: Array.isArray(obj.avoidFront) ? obj.avoidFront.map(String) : [],
      pairs: Array.isArray(obj.pairs)
        ? obj.pairs
            .filter(p => Array.isArray(p) && p.length >= 2)
            .map((p: string[]) => [String(p[0]), String(p[1])] as [string, string])
        : [],
      spread: !!obj.spread,
      strategy: obj.strategy === 'activity' ? 'activity' : (obj.strategy === 'class' ? 'class' : null),
    };
  } catch {
    return fallback;
  }
}

// ── 确定性排序 ────────────────────────────────────────

/**
 * 依约束产出落座顺序（最终与"未加任何约束时"无差异的输入恒等）。
 * 返回排好序的 students 副本；学生姓名重复时按"名单首次出现"匹配。
 */
/**
 * 依约束产出落座顺序。返回排好序的 students 副本；姓名重复时按"名单首次出现"匹配。
 * pairs 用并查集把要邻座的学生聚成组块，组内连续 → 落座时相邻（可能跨行尾，仍相邻）。
 */
export function orderStudentsForSeats(
  students: StudentRow[],
  constraint: SmartConstraint,
): StudentRow[] {
  const byName = new Map<string, string>();
  for (const s of students) if (!byName.has(s.name)) byName.set(s.name, s.id);

  const toIds = (names: string[]): string[] =>
    names.map(n => byName.get(n)).filter((id): id is string => !!id);

  const preferIds = new Set(toIds(constraint.preferFront));
  const avoidIds = new Set(toIds(constraint.avoidFront));

  // ── pairs → 邻座组（并查集） ──
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let p = x;
    while (parent.get(p) !== p) p = parent.get(p)!;
    parent.set(x, p); // path compress
    return p;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const s of students) parent.set(s.id, s.id);
  for (const [na, nb] of constraint.pairs) {
    const [ida, idb] = toIds([na, nb]);
    if (ida && idb) union(ida, idb);
  }
  // 名字到成员的映射（同组保持 pairs 给序 + 名单序兜底）
  const rootOf = (id: string) => find(id);
  const groups = new Map<string, StudentRow[]>();
  for (const s of students) {
    const root = rootOf(s.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(s);
  }
  // 组块：单个成员的组也作为一个块（保持其余原序稳定）
  const blocks = [...groups.values()];
  // 稳定性：按各组首个学生在名单中的原始下标排序
  const idxOf = new Map<string, number>();
  students.forEach((s, i) => idxOf.set(s.id, i));
  blocks.sort((a, b) => idxOf.get(a[0].id)! - idxOf.get(b[0].id)!);

  const split = (set: Set<string>) => blocks.filter(b => set.has(b[0].id));
  const prefer = split(preferIds);
  const avoid = split(avoidIds);
  const middle = blocks.filter(b => !preferIds.has(b[0].id) && !avoidIds.has(b[0].id));

  // 中间区按需打散（保持组分散），无随机则保持名单序
  if (constraint.spread) {
    middle.sort(() => Math.random() - 0.5);
  }

  const flatten = (bs: StudentRow[][]) => bs.flat();
  // strategy=activity：有 group 的组块前置（组内成员均带 group 才判定；否则垫底）
  if (constraint.strategy === 'activity') {
    const groupedBlocks = middle.filter(b => b.every(s => s.group_id));
    const ungroupedBlocks = middle.filter(b => !b.every(s => s.group_id));
    return [...flatten(prefer), ...flatten(groupedBlocks), ...flatten(ungroupedBlocks), ...flatten(avoid)];
  }
  return [...flatten(prefer), ...flatten(middle), ...flatten(avoid)];
}

/** 校验约束里的姓名是否都能对上名单（给出可读差役，便于日志/提示） */
export function validateConstraintNames(
  constraint: SmartConstraint,
  students: StudentRow[],
): { unknown: string[]; ok: boolean } {
  const known = new Set(students.map(s => s.name));
  const all = [...constraint.preferFront, ...constraint.avoidFront, ...constraint.pairs.flat()];
  const unknown = [...new Set(all.filter(n => !known.has(n)))];
  return { unknown, ok: unknown.length === 0 };
}
