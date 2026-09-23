import { useMemo } from 'react'
import { diagnose, summarize, type DiagItem } from '../diagnose/diagnose'
import { pageBboxesFromCache } from '../geo/pageBbox'
import { useStore } from './store'

/**
 * いま開いているファイルの診断。Footer だけで決まる項目はファイルを開いた時点で決まり、
 * Page Index が要る項目（ページ境界）は、Index を読むたびに判定を足す。
 */
export function useDiagnosis(): { items: DiagItem[]; summary: ReturnType<typeof summarize> } | undefined {
  const ins = useStore((s) => s.inspection)
  const cache = useStore((s) => s.pageCache)
  // PageCache 自体は変更を通知しないので、read が増えた（＝ Index を読んだかもしれない）ことを合図に判定し直す
  const readCount = useStore((s) => s.reads.length)
  return useMemo(() => {
    if (!ins || !cache) return undefined
    const items = diagnose(ins, (rg) => {
      const pb = pageBboxesFromCache(cache, ins.file.rowGroups[rg], ins.geo)
      return pb.available ? pb : undefined
    })
    return { items, summary: summarize(items) }
  }, [ins, cache, readCount])
}
