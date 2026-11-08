import argparse, json, os
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--input',required=True);parser.add_argument('--output',required=True);args=parser.parse_args()
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager
font=Path('C:/Windows/Fonts/malgun.ttf')
if font.exists():font_manager.fontManager.addfont(str(font));plt.rcParams['font.family']='Malgun Gothic'
plt.rcParams['axes.unicode_minus']=False
x=json.loads(Path(args.input).read_text(encoding='utf-8'));names={'trip':'트립닷컴 · 메인','google':'구글 항공편','skyscanner':'스카이스캐너','kayak':'카약','hana':'하나투어 (조건부)'};order=list(names);rows=sorted(x['comparison'],key=lambda r:order.index(r['providerId']));fig,ax=plt.subplots(figsize=(11,5.8),dpi=160);bars=ax.barh([names[r['providerId']] for r in rows],[r['price'] for r in rows],color=['#1c5bdb' if r['providerId']=='trip' else '#83a8e9' for r in rows]);ax.invert_yaxis();ax.set_xlim(0,max(r['price'] for r in rows)*1.28);ax.set_xlabel('검색 표시가 (원)');ax.set_title('같은 여행 조건의 사이트별 실제 검색 표시가',loc='left',pad=18,fontweight='bold');ax.spines[['top','right']].set_visible(False)
for bar,r in zip(bars,rows):ax.text(bar.get_width()+4000,bar.get_y()+bar.get_height()/2,f"{r['price']:,}원",va='center',fontsize=11)
fig.text(.05,.035,'인천–간사이 / 2026-12-26 ~ 2027-01-03 / 성인 1명\n2026-11-08 수집 기록 · 수하물/결제수단 포함 최종 총액 미검증 · 현재 가격 및 미래 예측 아님',fontsize=9,color='#52637b');fig.tight_layout(rect=[0,.11,1,1]);fig.savefig(args.output,bbox_inches='tight');plt.close(fig)
