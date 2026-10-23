import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  RuleBuilderCanvas,
  validateAST,
  compileAST,
  createDefaultGroup,
  createDefaultCondition,
  SerializedGroupAST,
  VisualGroupNode,
} from '../RuleBuilderCanvas';

describe('RuleBuilderCanvas Component (Issue #741)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders root logic group, initial condition node, and live AST preview', () => {
    render(<RuleBuilderCanvas />);

    expect(screen.getByTestId('rule-builder-canvas')).toBeInTheDocument();
    expect(screen.getByText('Root Logic Group')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'AND' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'OR' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'NOT' })).toBeInTheDocument();

    expect(screen.getByLabelText('Condition Field')).toBeInTheDocument();
    expect(screen.getByLabelText('Condition Operator')).toBeInTheDocument();
    expect(screen.getByLabelText('Condition Value')).toBeInTheDocument();

    expect(screen.getByTestId('ast-preview')).toBeInTheDocument();
    expect(screen.getByTestId('drag-handle')).toBeInTheDocument();
  });

  it('allows switching root logic between AND, OR, and NOT and updates compiled AST', async () => {
    const user = userEvent.setup();
    render(<RuleBuilderCanvas />);

    const orBtn = screen.getByRole('button', { name: 'OR' });
    await user.click(orBtn);
    expect(screen.getByTestId('ast-preview')).toHaveTextContent('"logic": "OR"');

    const notBtn = screen.getByRole('button', { name: 'NOT' });
    await user.click(notBtn);
    expect(screen.getByTestId('ast-preview')).toHaveTextContent('"logic": "NOT"');
    expect(screen.getByText('(Inverts all child conditions)')).toBeInTheDocument();
  });

  it('adds a new condition, edits fields, and compiles AST accurately', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<RuleBuilderCanvas onSave={onSave} />);

    // Fill first condition: amount > 500
    const valueInput = screen.getByLabelText('Condition Value');
    await user.type(valueInput, '500');

    // Add second condition
    const addCondBtn = screen.getByRole('button', { name: /Add Condition/i });
    await user.click(addCondBtn);

    const fieldSelects = screen.getAllByLabelText('Condition Field');
    expect(fieldSelects).toHaveLength(2);

    // Switch second condition to asset
    await user.selectOptions(fieldSelects[1], 'asset');

    const valueInputs = screen.getAllByLabelText('Condition Value');
    await user.type(valueInputs[1], 'USDC');

    // Save
    const saveBtn = screen.getByTestId('save-ast-button');
    await user.click(saveBtn);

    const expectedAST: SerializedGroupAST = {
      logic: 'AND',
      conditions: [
        { field: 'amount', operator: 'gt', value: '500' },
        { field: 'asset', operator: 'eq', value: 'USDC' },
      ],
    };

    expect(onSave).toHaveBeenCalledWith(expectedAST);
    expect(screen.getByTestId('save-success-banner')).toBeInTheDocument();
  });

  it('supports building and nesting recursive logical groups (e.g. (Amount > 1000) OR (Sender is G...))', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<RuleBuilderCanvas onSave={onSave} />);

    // Root is AND: fill first condition
    const firstValue = screen.getByLabelText('Condition Value');
    await user.type(firstValue, '1000');

    // Add nested group
    const addGroupBtn = screen.getByRole('button', { name: /Add Group/i });
    await user.click(addGroupBtn);

    expect(screen.getByText(/Nested Group \(L1\)/i)).toBeInTheDocument();

    // In nested group, find the second value input
    const allValueInputs = screen.getAllByLabelText('Condition Value');
    expect(allValueInputs).toHaveLength(2);

    const allFieldSelects = screen.getAllByLabelText('Condition Field');
    await user.selectOptions(allFieldSelects[1], 'sender');
    await user.type(allValueInputs[1], 'GABC123456');

    // Save and check AST hierarchy
    const saveBtn = screen.getByTestId('save-ast-button');
    await user.click(saveBtn);

    expect(onSave).toHaveBeenCalledWith({
      logic: 'AND',
      conditions: [
        { field: 'amount', operator: 'gt', value: '1000' },
        {
          logic: 'OR',
          conditions: [
            { field: 'sender', operator: 'eq', value: 'GABC123456' },
          ],
        },
      ],
    });
  });

  it('supports deleting individual condition nodes and entire nested groups', async () => {
    const user = userEvent.setup();
    render(<RuleBuilderCanvas />);

    // Add condition
    await user.click(screen.getByRole('button', { name: /Add Condition/i }));
    expect(screen.getAllByLabelText('Condition Value')).toHaveLength(2);

    // Delete second condition
    const deleteButtons = screen.getAllByLabelText('Remove condition');
    await user.click(deleteButtons[1]);
    expect(screen.getAllByLabelText('Condition Value')).toHaveLength(1);

    // Add group and then delete it
    await user.click(screen.getByRole('button', { name: /Add Group/i }));
    expect(screen.getByText(/Nested Group \(L1\)/i)).toBeInTheDocument();

    const deleteGroupBtn = screen.getByLabelText('Delete Group');
    await user.click(deleteGroupBtn);
    expect(screen.queryByText(/Nested Group \(L1\)/i)).not.toBeInTheDocument();
  });

  it('flags validation errors when required threshold values are empty or non-numeric for amount', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<RuleBuilderCanvas onSave={onSave} />);

    // Leave value empty and attempt save
    const saveBtn = screen.getByTestId('save-ast-button');
    await user.click(saveBtn);

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/Value \/ threshold is required/i)).toBeInTheDocument();
    expect(screen.getByTestId('validation-alert')).toBeInTheDocument();

    // Type non-numeric value for amount
    const valueInput = screen.getByLabelText('Condition Value');
    await user.type(valueInput, 'invalid-num');

    expect(screen.getByText(/Amount threshold must be a valid numeric value/i)).toBeInTheDocument();
  });

  it('toggles AST JSON preview visibility and copies JSON to clipboard', async () => {
    const user = userEvent.setup();
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    });

    render(<RuleBuilderCanvas />);

    const toggleBtn = screen.getByTestId('toggle-preview-btn');
    expect(screen.getByTestId('ast-preview-section')).toBeInTheDocument();

    // Hide preview
    await user.click(toggleBtn);
    expect(screen.queryByTestId('ast-preview-section')).not.toBeInTheDocument();
    expect(toggleBtn).toHaveTextContent('Show AST JSON');

    // Re-open preview
    await user.click(toggleBtn);
    expect(screen.getByTestId('ast-preview-section')).toBeInTheDocument();

    // Copy JSON
    const copyBtn = screen.getByTestId('copy-ast-btn');
    await user.click(copyBtn);
    expect(writeTextMock).toHaveBeenCalled();
    expect(screen.getByText('✓ Copied!')).toBeInTheDocument();
  });

  describe('Pure helper functions (validateAST & compileAST)', () => {
    it('validates empty groups correctly', () => {
      const emptyGroup: VisualGroupNode = {
        id: 'group-empty',
        type: 'group',
        logic: 'AND',
        children: [],
      };
      const result = validateAST(emptyGroup);
      expect(result.isValid).toBe(false);
      expect(result.errors['group-empty']).toContain('at least one condition');
    });

    it('compiles nested group AST accurately', () => {
      const tree: VisualGroupNode = {
        id: 'g-root',
        type: 'group',
        logic: 'OR',
        children: [
          {
            id: 'c-1',
            type: 'condition',
            field: 'amount',
            operator: 'gte',
            value: '250.5',
          },
          {
            id: 'g-sub',
            type: 'group',
            logic: 'NOT',
            children: [
              {
                id: 'c-2',
                type: 'condition',
                field: 'recipient',
                operator: 'contains',
                value: 'TREASURY',
              },
            ],
          },
        ],
      };

      const compiled = compileAST(tree);
      expect(compiled).toEqual({
        logic: 'OR',
        conditions: [
          { field: 'amount', operator: 'gte', value: '250.5' },
          {
            logic: 'NOT',
            conditions: [
              { field: 'recipient', operator: 'contains', value: 'TREASURY' },
            ],
          },
        ],
      });
    });
  });
});
