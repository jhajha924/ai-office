import type { ActorStatus, FeedKind } from '../../server/src/office/types.ts';

/**
 * Every fixed piece of interface text the page shows, in one place. Adding a
 * language later means adding another object of the same shape and picking
 * it at start-up; nothing else has to change. Text built on the server
 * (status bubbles, feed lines) is not here.
 */

export const TEXT = {
  pageTitle: 'AI 辦公室',
  brand: 'AI 辦公室',
  buildingsLabel: '棟',
  officeLabel: '3D 辦公室',
  sidebarLabel: '小組狀態',
  feedLabel: '動態牆',
  feedTitle: '動態',
  cardsLabel: '員工卡片',
  empty: '目前沒有對話',
  offline: '連線中斷，重新連線中',
  colNeeds: '需要你',
  colWorking: '工作中',
  colDone: '已完成',
  waitingBadge: '等你',
  statWorking: (n: number) => `工作中 ${n}`,
  statOutputs: (n: number) => `產出 ${n}`,
  statWaiting: (n: number) => `等你 ${n}`,
  unseated: '未入座',
  levelsLabel: '樓層',
  allFloors: '整棟',
  slabLabel: (tag: string, name: string, groups: number, working: number, waiting: number) =>
    `${tag} ${name}｜${groups} 組｜工作中 ${working}・等你 ${waiting}`,
  levelButton: (tag: string, name: string) => `${tag} ${name}`,
  roomPresident: '總裁室',
  roomManagers: '主管會議室',
  roomLead: '組長室',
  elevator: '電梯',
  boardDecide: (n: number) => `待你決議 ${n}`,
  boardStuck: (n: number) => `卡住 ${n}`,
  boardFeed: (n: number) => `最新動態 ${n}`,
  boardNone: '（無）',
  boardHeading: '1F 戰情看板',
  overflow: (n: number) => `另有 ${n} 組在線上`,
  fileCount: (n: number) => `${n} 個檔案`,
  previewLabel: (name: string) => `預覽 ${name}`,
  previewLoading: '讀取中…',
  previewRefused: '此樓層不提供預覽',
  previewMissing: '檔案不存在或已移除',
  previewBinary: '（二進位檔，無法預覽）',
  previewFailed: '讀取失敗，請稍後再試',
  previewTruncated: (name: string) => `${name}（只顯示前 256KB）`,
  sceneLoadFailed: (reason: string) => `3D 素材載入失敗，請重新整理頁面（${reason}）`,
};

/** The status word on a card. */
export const STATUS_TEXT: Record<ActorStatus, string> = {
  'idle-new': '待命',
  thinking: '思考中',
  running: '執行中',
  replying: '回覆中',
  done: '已完成',
  waiting: '等你',
  stuck: '卡住？',
  idle: '閒置',
  dozing: '打瞌睡',
};

/** The category in front of a feed line on the lobby's war-room board. */
export const FEED_CATEGORY: Record<FeedKind, string> = {
  done: '完成',
  handoff: '交辦',
  return: '回報',
  waiting: '等你',
};

/** The keys of TEXT that are plain strings, usable from data-text attributes in index.html. */
export type StaticTextKey = { [K in keyof typeof TEXT]: (typeof TEXT)[K] extends string ? K : never }[keyof typeof TEXT];

/**
 * Fills index.html: an element with data-text gets that text as its content,
 * data-text-label as its aria-label.
 */
export function applyStaticText(root: ParentNode): void {
  for (const node of root.querySelectorAll<HTMLElement>('[data-text]')) {
    const value = TEXT[node.dataset.text as StaticTextKey];
    if (typeof value === 'string') node.textContent = value;
  }
  for (const node of root.querySelectorAll<HTMLElement>('[data-text-label]')) {
    const value = TEXT[node.dataset.textLabel as StaticTextKey];
    if (typeof value === 'string') node.setAttribute('aria-label', value);
  }
}
