import { GROUP_LABEL, type DiagGroup, type DiagItem, type Verdict } from '../../diagnose/diagnose'
import { useDiagnosis } from '../../state/diagnosis'
import { useStore, type Selection } from '../../state/store'

const VERDICT_LABEL: Record<Verdict, string> = { ok: '満たす', ng: '違反', warn: '注意', info: '参考値', unknown: '未確認', na: '対象外' }
const GROUPS: DiagGroup[] = ['must', 'should', 'hint']

/**
 * 診断（design.md D41）。MUST・SHOULD・仕様外の目安を別の表に分け、MUST の違反と SHOULD の注意を混ぜない。
 * 行をクリックすると該当する Row Group などを選び、地図・ツリー・Physical File Map がそこを示す。
 */
export function DiagnosisView() {
  const d = useDiagnosis()
  const select = useStore((s) => s.select)
  if (!d) return null
  const go = (t?: Selection) => t && select(t, 'inspector')
  return (
    <>
      <h3>診断</h3>
      <p>
        MUST 違反 <b className={d.summary.mustNg ? 'verdict-ng' : 'verdict-ok'}>{d.summary.mustNg}</b> 件 ・ SHOULD・目安の注意 <b className={d.summary.warn ? 'verdict-warn' : 'verdict-ok'}>{d.summary.warn}</b> 件 ・ 未確認 {d.summary.unknown} 件
      </p>
      {GROUPS.map((g) => (
        <section key={g}>
          <h4>{GROUP_LABEL[g]}</h4>
          <table className="table diag">
            <tbody>
              {d.items
                .filter((i) => i.group === g)
                .map((i) => (
                  <DiagRow key={i.id} item={i} onGo={go} />
                ))}
            </tbody>
          </table>
        </section>
      ))}
      <p className="muted">判定に使ったのは Footer（と、読み込み済みの Page Index）だけです。データページは読んでいません。</p>
    </>
  )
}

function DiagRow({ item, onGo }: { item: DiagItem; onGo: (t?: Selection) => void }) {
  return (
    <>
      <tr className={item.target ? 'clickable' : undefined} onClick={() => onGo(item.target)}>
        <td>
          <span className={`verdict verdict-${item.verdict}`}>{VERDICT_LABEL[item.verdict]}</span>
        </td>
        <td>
          <div>{item.title}</div>
          <div className="diag-value">{item.value}</div>
          {item.note && <div className="muted diag-note">{item.note}</div>}
        </td>
      </tr>
      {item.details?.map((x) => (
        <tr key={x.label} className={`diag-detail${x.target ? ' clickable' : ''}`} onClick={() => onGo(x.target)}>
          <td />
          <td>
            <span className="diag-detail-label">{x.label}</span> {x.value}
          </td>
        </tr>
      ))}
    </>
  )
}
