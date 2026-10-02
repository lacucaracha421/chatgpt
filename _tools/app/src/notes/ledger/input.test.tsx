import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { formatAmountInput, parseAmount } from './input';
import { PlanEditor, RecurringEditor } from './LedgerEditors';

afterEach(cleanup);
it.each(['10,000.00', '-10000', '10,00', '1e3', '1000000000000'])('rejects malformed or out-of-range amounts without sanitizing them: %s', text => {
  expect(parseAmount(text)).toBeNull();
  expect(parseAmount(formatAmountInput(text))).toBeNull();
});
it('accepts integer prices and preserves the entry income shorthand', () => {
  expect(parseAmount('10,000')).toEqual({ amount: 10000, in: false });
  expect(parseAmount('10000')).toEqual({ amount: 10000, in: false });
  expect(parseAmount(' +10,000 ')).toEqual({ amount: 10000, in: true });
  expect(formatAmountInput('10000')).toBe('10,000');
});
it.each(['recurring', 'plan'])('rejects pasted decimals/negatives in the %s editor with a short explanation', async kind => {
  const save = vi.fn().mockResolvedValue(true);
  render(kind === 'recurring'
    ? <RecurringEditor today="2026-10-02" onSave={save} onClose={() => {}} />
    : <PlanEditor month="2026-10" onSave={save} onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText('이름'), { target: { value: '테스트' } });
  for (const value of ['10,000.00', '-10000']) {
    fireEvent.change(screen.getByLabelText('가격'), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('가격은 0 이상의 정수로');
  }
  fireEvent.change(screen.getByLabelText('가격'), { target: { value: '10,000' } });
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ amount: 10000 })));
});
