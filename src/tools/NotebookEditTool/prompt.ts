export const DESCRIPTION =
  'Replace the contents of a specific cell in a Jupyter notebook.'
export const PROMPT = `Replace, insert, or delete one cell in a Jupyter notebook (.ipynb).
- Read the notebook first in this conversation; the edit fails otherwise. \`notebook_path\` must be absolute.
- \`cell_id\` is the id from the Read output's \`<cell id="...">\` tag (e.g. "cell-2" when the cell has no own id). Required for replace and delete.
- \`edit_mode\`: "replace" (default), "insert" (adds a cell after \`cell_id\`, or first when cell_id is omitted; \`cell_type\` is required), or "delete".`
