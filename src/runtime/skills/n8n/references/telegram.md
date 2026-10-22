# Show a workflow on Telegram

Telegram can't show the canvas file, but it shows pictures. Attach a picture of the workflow instead of the `.n8n.json` file:

1. Write the workflow file as usual, such as `n8n/order-alerts.n8n.json`.
2. Save the script below once as `n8n/picture.py`, then run `python3 n8n/picture.py n8n/order-alerts.n8n.json n8n/order-alerts.png`.
3. Look at the picture, then attach it with share_file and put the workflow's n8n link in your message.

```python
import json, sys, textwrap
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch

source, target = sys.argv[1], sys.argv[2]
flow = json.load(open(source))
flow = flow.get('workflow', flow)
nodes = {n['name']: n for n in flow['nodes'] if not n['type'].endswith('stickyNote')}
at = {name: (n['position'][0] * 1.25, -n['position'][1] * 1.25) for name, n in nodes.items()}
w, h = 150, 64
xs, ys = [p[0] for p in at.values()], [p[1] for p in at.values()]
fig, ax = plt.subplots(figsize=(min(22, max(6, (max(xs) - min(xs) + 2 * w) / 100)), min(22, max(3, (max(ys) - min(ys) + 3 * h) / 100))), dpi=180)
for start, kinds in flow.get('connections', {}).items():
    for kind, outputs in kinds.items():
        for links in outputs or []:
            for link in links or []:
                if start in at and link['node'] in at:
                    (x1, y1), (x2, y2) = at[start], at[link['node']]
                    main = kind == 'main'
                    side = 1 if x2 >= x1 else -1
                    bend = 0.5 if side < 0 else 0 if abs(y1 - y2) < 5 else (0.2 if y2 < y1 else -0.2)
                    ax.annotate('', xy=(x2 - side * w / 2, y2) if main else (x2, y2 - h / 2), xytext=(x1 + side * w / 2, y1) if main else (x1, y1 + h / 2),
                                arrowprops=dict(arrowstyle='-|>', color='#8d8d8d', lw=1.1, ls='-' if main else (0, (3, 3)),
                                                connectionstyle=f'arc3,rad={bend if main else 0}'))
for name, n in nodes.items():
    x, y = at[name]
    trigger = 'trigger' in n['type'].lower() or n['type'].endswith('.webhook')
    ax.add_patch(FancyBboxPatch((x - w / 2, y - h / 2), w, h, boxstyle='round,pad=0,rounding_size=12',
                                fc='#fff4f2' if trigger else 'white', ec='#ff6d5a' if trigger else '#c9c9d4', lw=1.4))
    ax.text(x, y, '\n'.join(textwrap.wrap(name, 20)[:3]), ha='center', va='center', fontsize=7.5, color='#222')
ax.set_xlim(min(xs) - w, max(xs) + w)
ax.set_ylim(min(ys) - 1.5 * h, max(ys) + 1.5 * h)
ax.set_aspect('equal')
ax.axis('off')
ax.set_title(flow.get('name', ''), fontsize=10, color='#222', loc='left')
fig.savefig(target, bbox_inches='tight', facecolor='white')
```
