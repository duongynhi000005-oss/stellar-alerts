import React, { useState } from 'react';

export type RuleField = 'amount' | 'asset' | 'sender' | 'recipient';
export type LogicalOperator = 'AND' | 'OR' | 'NOT';
export type RuleOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'in';

export interface VisualConditionNode {
  id: string;
  type: 'condition';
  field: RuleField;
  operator: RuleOperator;
  value: string;
}

export interface VisualGroupNode {
  id: string;
  type: 'group';
  logic: LogicalOperator;
  children: (VisualConditionNode | VisualGroupNode)[];
}

export type VisualASTNode = VisualConditionNode | VisualGroupNode;

export interface SerializedConditionAST {
  field: RuleField;
  operator: RuleOperator;
  value: string;
}

export interface SerializedGroupAST {
  logic: LogicalOperator;
  conditions: (SerializedConditionAST | SerializedGroupAST)[];
}

export interface RuleBuilderCanvasProps {
  initialTree?: VisualGroupNode;
  onSave?: (ast: SerializedGroupAST) => void;
  className?: string;
}

export const FIELD_CONFIG: Record<RuleField, { label: string; placeholder: string }> = {
  amount: { label: 'Amount', placeholder: 'e.g. 1000' },
  asset: { label: 'Asset', placeholder: 'e.g. USDC / XLM' },
  sender: { label: 'Sender', placeholder: 'G... or wallet alias' },
  recipient: { label: 'Recipient', placeholder: 'G... or address' },
};

export const OPERATORS_BY_FIELD: Record<RuleField, { value: RuleOperator; label: string }[]> = {
  amount: [
    { value: 'gt', label: '> (greater than)' },
    { value: 'gte', label: '≥ (greater or equal)' },
    { value: 'lt', label: '< (less than)' },
    { value: 'lte', label: '≤ (less or equal)' },
    { value: 'eq', label: '= (equals)' },
    { value: 'neq', label: '≠ (not equal)' },
  ],
  asset: [
    { value: 'eq', label: 'is (exact match)' },
    { value: 'neq', label: 'is not' },
    { value: 'in', label: 'in list (comma-separated)' },
  ],
  sender: [
    { value: 'eq', label: 'is' },
    { value: 'neq', label: 'is not' },
    { value: 'contains', label: 'contains' },
    { value: 'in', label: 'in VIP list' },
  ],
  recipient: [
    { value: 'eq', label: 'is' },
    { value: 'neq', label: 'is not' },
    { value: 'contains', label: 'contains' },
    { value: 'in', label: 'in watch list' },
  ],
};

let nextNodeId = 0;
export const generateNodeId = (prefix: string = 'node'): string =>
  `${prefix}-${Date.now().toString(36)}-${(nextNodeId++).toString(36)}`;

export const createDefaultCondition = (field: RuleField = 'amount'): VisualConditionNode => ({
  id: generateNodeId('cond'),
  type: 'condition',
  field,
  operator: OPERATORS_BY_FIELD[field][0].value,
  value: '',
});

export const createDefaultGroup = (logic: LogicalOperator = 'AND'): VisualGroupNode => ({
  id: generateNodeId('group'),
  type: 'group',
  logic,
  children: [createDefaultCondition()],
});

export const validateAST = (
  node: VisualGroupNode,
): { isValid: boolean; errors: Record<string, string> } => {
  const errors: Record<string, string> = {};

  const validateRecursive = (curr: VisualASTNode) => {
    if (curr.type === 'condition') {
      if (!curr.value || !curr.value.trim()) {
        errors[curr.id] = 'Value / threshold is required.';
      } else if (curr.field === 'amount' && Number.isNaN(Number(curr.value))) {
        errors[curr.id] = 'Amount threshold must be a valid numeric value.';
      }
    } else if (curr.type === 'group') {
      if (!curr.children || curr.children.length === 0) {
        errors[curr.id] = 'Logical group must contain at least one condition or nested group.';
      } else {
        for (const child of curr.children) {
          validateRecursive(child);
        }
      }
    }
  };

  validateRecursive(node);
  return { isValid: Object.keys(errors).length === 0, errors };
};

export const compileAST = (node: VisualGroupNode): SerializedGroupAST => {
  const compileNode = (
    child: VisualASTNode,
  ): SerializedConditionAST | SerializedGroupAST => {
    if (child.type === 'condition') {
      return {
        field: child.field,
        operator: child.operator,
        value: child.value.trim(),
      };
    }
    return compileAST(child);
  };

  return {
    logic: node.logic,
    conditions: node.children.map(compileNode),
  };
};

export const RuleBuilderCanvas: React.FC<RuleBuilderCanvasProps> = ({
  initialTree,
  onSave,
  className = '',
}) => {
  const [root, setRoot] = useState<VisualGroupNode>(
    () => initialTree || createDefaultGroup('AND'),
  );
  const [showJsonPreview, setShowJsonPreview] = useState(true);
  const [touched, setTouched] = useState(false);
  const [copied, setCopied] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);

  const { isValid, errors } = validateAST(root);
  const compiledAST = compileAST(root);
  const formattedJson = JSON.stringify(compiledAST, null, 2);

  // Tree mutation helpers
  const updateGroupLogic = (groupId: string, logic: LogicalOperator) => {
    const updateRecursive = (node: VisualGroupNode): VisualGroupNode => {
      if (node.id === groupId) {
        return { ...node, logic };
      }
      return {
        ...node,
        children: node.children.map((ch) =>
          ch.type === 'group' ? updateRecursive(ch) : ch,
        ),
      };
    };
    setRoot(updateRecursive(root));
  };

  const addConditionToGroup = (groupId: string, field: RuleField = 'amount') => {
    const updateRecursive = (node: VisualGroupNode): VisualGroupNode => {
      if (node.id === groupId) {
        return {
          ...node,
          children: [...node.children, createDefaultCondition(field)],
        };
      }
      return {
        ...node,
        children: node.children.map((ch) =>
          ch.type === 'group' ? updateRecursive(ch) : ch,
        ),
      };
    };
    setRoot(updateRecursive(root));
  };

  const addSubGroupToGroup = (groupId: string, logic: LogicalOperator = 'OR') => {
    const updateRecursive = (node: VisualGroupNode): VisualGroupNode => {
      if (node.id === groupId) {
        return {
          ...node,
          children: [...node.children, createDefaultGroup(logic)],
        };
      }
      return {
        ...node,
        children: node.children.map((ch) =>
          ch.type === 'group' ? updateRecursive(ch) : ch,
        ),
      };
    };
    setRoot(updateRecursive(root));
  };

  const updateConditionNode = (
    condId: string,
    updates: Partial<VisualConditionNode>,
  ) => {
    const updateRecursive = (node: VisualGroupNode): VisualGroupNode => {
      return {
        ...node,
        children: node.children.map((ch) => {
          if (ch.type === 'group') return updateRecursive(ch);
          if (ch.id === condId) {
            const next = { ...ch, ...updates };
            if (updates.field && updates.field !== ch.field) {
              next.operator = OPERATORS_BY_FIELD[updates.field][0].value;
            }
            return next;
          }
          return ch;
        }),
      };
    };
    setRoot(updateRecursive(root));
  };

  const deleteNode = (nodeId: string) => {
    const deleteRecursive = (node: VisualGroupNode): VisualGroupNode => {
      return {
        ...node,
        children: node.children
          .filter((ch) => ch.id !== nodeId)
          .map((ch) => (ch.type === 'group' ? deleteRecursive(ch) : ch)),
      };
    };
    setRoot(deleteRecursive(root));
  };

  const handleSave = () => {
    setTouched(true);
    if (!isValid) return;
    if (onSave) {
      onSave(compiledAST);
    }
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 2500);
  };

  const handleCopyJson = () => {
    navigator.clipboard?.writeText(formattedJson);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Render group node recursively
  const renderGroupNode = (
    group: VisualGroupNode,
    isRoot: boolean = false,
    depth: number = 0,
  ) => {
    const groupError = errors[group.id];
    const logicColors: Record<LogicalOperator, { bg: string; border: string; text: string }> = {
      AND: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/40', text: 'text-emerald-400' },
      OR: { bg: 'bg-amber-500/10', border: 'border-amber-500/40', text: 'text-amber-400' },
      NOT: { bg: 'bg-purple-500/10', border: 'border-purple-500/40', text: 'text-purple-400' },
    };
    const currentTheme = logicColors[group.logic];

    return (
      <div
        key={group.id}
        data-testid={`group-node-${group.id}`}
        className={`relative flex flex-col rounded-xl border p-4 transition-all ${
          isRoot
            ? 'bg-slate-900/95 border-slate-700/80 shadow-2xl'
            : 'bg-slate-950/70 border-slate-800 shadow-md ml-4 sm:ml-8 mt-3'
        } ${groupError ? 'border-red-500/80 ring-1 ring-red-500/40' : ''}`}
      >
        {/* Header & Combinator selector */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold tracking-wider uppercase text-slate-400">
              {isRoot ? 'Root Logic Group' : `Nested Group (L${depth})`}
            </span>
            <div className="inline-flex rounded-lg bg-slate-950 p-1 border border-slate-800">
              {(['AND', 'OR', 'NOT'] as LogicalOperator[]).map((op) => {
                const isActive = group.logic === op;
                return (
                  <button
                    key={op}
                    type="button"
                    onClick={() => updateGroupLogic(group.id, op)}
                    data-testid={`logic-btn-${group.id}-${op}`}
                    className={`px-2.5 py-1 text-xs font-bold rounded-md transition-all ${
                      isActive
                        ? `${logicColors[op].bg} ${logicColors[op].border} ${logicColors[op].text} border shadow-sm`
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {op}
                  </button>
                );
              })}
            </div>
            {group.logic === 'NOT' && (
              <span className="text-[11px] text-purple-300/80 italic">
                (Inverts all child conditions)
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => addConditionToGroup(group.id)}
              data-testid={`add-cond-${group.id}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-xs font-medium text-cyan-300 hover:bg-cyan-500/20 hover:border-cyan-500/50 transition-all"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add Condition
            </button>
            <button
              type="button"
              onClick={() => addSubGroupToGroup(group.id, group.logic === 'AND' ? 'OR' : 'AND')}
              data-testid={`add-group-${group.id}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-1 text-xs font-medium text-indigo-300 hover:bg-indigo-500/20 hover:border-indigo-500/50 transition-all"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16m-7 6h7" />
              </svg>
              Add Group
            </button>
            {!isRoot && (
              <button
                type="button"
                onClick={() => deleteNode(group.id)}
                data-testid={`delete-group-${group.id}`}
                aria-label="Delete Group"
                className="rounded-lg p-1 text-slate-500 hover:bg-red-500/20 hover:text-red-400 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {groupError && (
          <div
            data-testid={`error-${group.id}`}
            className="mt-2 text-xs font-medium text-red-400 flex items-center gap-1"
          >
            <span>⚠️ {groupError}</span>
          </div>
        )}

        {/* Child nodes container with SVG branch tree */}
        <div className="relative mt-3 flex flex-col gap-3 pl-2 sm:pl-4 border-l-2 border-slate-800">
          {group.children.length === 0 ? (
            <div className="py-6 text-center text-xs text-slate-500 italic">
              No conditions in this group. Click &quot;Add Condition&quot; or &quot;Add Group&quot; above.
            </div>
          ) : (
            group.children.map((child, index) => {
              if (child.type === 'group') {
                return renderGroupNode(child, false, depth + 1);
              }
              return renderConditionNode(child, group.id);
            })
          )}
        </div>
      </div>
    );
  };

  // Render individual leaf condition node
  const renderConditionNode = (node: VisualConditionNode, parentGroupId: string) => {
    const errorMsg = errors[node.id];
    const operators = OPERATORS_BY_FIELD[node.field] || [];
    const config = FIELD_CONFIG[node.field] || { label: node.field, placeholder: 'Value' };

    return (
      <div
        key={node.id}
        data-testid={`condition-node-${node.id}`}
        className={`group relative flex flex-wrap items-center gap-2 rounded-lg border p-3 transition-all ${
          errorMsg
            ? 'border-red-500/70 bg-red-950/20 shadow-[0_0_12px_rgba(239,68,68,0.15)]'
            : 'border-slate-800/90 bg-slate-900/80 hover:border-slate-700 hover:bg-slate-900'
        }`}
      >
        {/* Node Drag/Reorder visual indicator */}
        <div
          data-testid="drag-handle"
          className="text-slate-600 hover:text-slate-400 cursor-grab px-1 select-none"
          title="Drag node"
        >
          ⋮⋮
        </div>

        {/* Field Selector */}
        <div className="flex flex-col">
          <label htmlFor={`field-${node.id}`} className="sr-only">
            Condition Field
          </label>
          <select
            id={`field-${node.id}`}
            value={node.field}
            aria-label="Condition Field"
            data-testid={`field-select-${node.id}`}
            onChange={(e) =>
              updateConditionNode(node.id, { field: e.target.value as RuleField })
            }
            className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs font-semibold text-slate-200 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400"
          >
            {(Object.keys(FIELD_CONFIG) as RuleField[]).map((f) => (
              <option key={f} value={f}>
                {FIELD_CONFIG[f].label}
              </option>
            ))}
          </select>
        </div>

        {/* Operator Selector */}
        <div className="flex flex-col">
          <label htmlFor={`operator-${node.id}`} className="sr-only">
            Condition Operator
          </label>
          <select
            id={`operator-${node.id}`}
            value={node.operator}
            aria-label="Condition Operator"
            data-testid={`operator-select-${node.id}`}
            onChange={(e) =>
              updateConditionNode(node.id, {
                operator: e.target.value as RuleOperator,
              })
            }
            className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs font-mono text-cyan-300 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400"
          >
            {operators.map((op) => (
              <option key={op.value} value={op.value}>
                {op.label}
              </option>
            ))}
          </select>
        </div>

        {/* Value Input */}
        <div className="flex-1 min-w-[140px] flex flex-col">
          <label htmlFor={`value-${node.id}`} className="sr-only">
            Condition Value
          </label>
          <input
            id={`value-${node.id}`}
            type="text"
            value={node.value}
            aria-label="Condition Value"
            data-testid={`value-input-${node.id}`}
            placeholder={config.placeholder}
            onChange={(e) => updateConditionNode(node.id, { value: e.target.value })}
            className={`w-full rounded-lg border bg-slate-950 px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 ${
              errorMsg
                ? 'border-red-500 focus:border-red-500 focus:ring-red-500'
                : 'border-slate-700 focus:border-cyan-400 focus:ring-cyan-400'
            }`}
          />
        </div>

        {/* Delete node button */}
        <button
          type="button"
          onClick={() => deleteNode(node.id)}
          data-testid={`delete-node-${node.id}`}
          aria-label="Remove condition"
          className="rounded-lg p-1 text-slate-500 hover:bg-red-500/20 hover:text-red-400 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>

        {/* Inline Error Message */}
        {errorMsg && (
          <div
            data-testid={`error-${node.id}`}
            className="w-full text-[11px] font-medium text-red-400 flex items-center gap-1 pl-1"
          >
            <span>⚠️ {errorMsg}</span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      data-testid="rule-builder-canvas"
      className={`flex flex-col gap-5 rounded-2xl border border-slate-800 bg-slate-950 p-4 sm:p-6 text-white shadow-2xl ${className}`}
    >
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse" />
            Visual Alert Rule AST Visualizer
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Build, nest, and serialize multi-layered logic conditions (AND, OR, NOT) visually.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowJsonPreview((prev) => !prev)}
            data-testid="toggle-preview-btn"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800 hover:text-white transition-all"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
            </svg>
            {showJsonPreview ? 'Hide AST JSON' : 'Show AST JSON'}
          </button>

          <button
            type="button"
            onClick={handleSave}
            data-testid="save-ast-button"
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-bold transition-all shadow-lg ${
              isValid
                ? 'bg-gradient-to-r from-cyan-500 to-blue-600 text-white hover:from-cyan-400 hover:to-blue-500 shadow-cyan-500/20 active:scale-95'
                : 'bg-slate-800 text-slate-500 border border-slate-700/60 cursor-not-allowed'
            }`}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            Save Rule AST
          </button>
        </div>
      </div>

      {savedSuccess && (
        <div
          data-testid="save-success-banner"
          className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2.5 text-xs font-semibold text-emerald-300 flex items-center justify-between"
        >
          <span>✓ Rule AST validated and compiled successfully!</span>
        </div>
      )}

      {touched && !isValid && (
        <div
          data-testid="validation-alert"
          className="rounded-lg border border-red-500/40 bg-red-950/30 px-4 py-2.5 text-xs font-medium text-red-300 flex items-center gap-2"
        >
          <span>⚠️ Please resolve condition errors highlighted above before saving.</span>
        </div>
      )}

      {/* Main Canvas View */}
      <div className="relative min-h-[280px] overflow-x-auto rounded-xl border border-slate-800/80 bg-slate-900/40 p-4">
        {renderGroupNode(root, true, 0)}
      </div>

      {/* Live AST Preview Section */}
      {showJsonPreview && (
        <div
          data-testid="ast-preview-section"
          className="relative rounded-xl border border-slate-800 bg-slate-950/90 p-4"
        >
          <div className="flex items-center justify-between border-b border-slate-800/80 pb-2 mb-3">
            <span className="text-xs font-mono font-semibold text-cyan-400 uppercase tracking-wider flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" />
              Compiled JSON AST (Live)
            </span>
            <button
              type="button"
              onClick={handleCopyJson}
              data-testid="copy-ast-btn"
              className="text-xs font-medium text-slate-400 hover:text-white transition-colors"
            >
              {copied ? '✓ Copied!' : 'Copy JSON'}
            </button>
          </div>
          <pre
            data-testid="ast-preview"
            className="max-h-64 overflow-y-auto font-mono text-xs text-slate-300 bg-slate-900/60 p-3 rounded-lg border border-slate-800/60"
          >
            {formattedJson}
          </pre>
        </div>
      )}
    </div>
  );
};

export default RuleBuilderCanvas;
