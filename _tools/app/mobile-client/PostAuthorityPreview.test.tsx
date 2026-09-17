import '@testing-library/jest-dom/vitest';
import {fireEvent, render, screen} from '@testing-library/react';
import {describe, expect, it} from 'vitest';
import {PostAuthorityPreview} from './PostAuthorityPreview';

describe('post-authority mobile preview', () => {
  it('opens and closes Activity & Sync from the passive pending status', () => {
    render(<PostAuthorityPreview/>);

    fireEvent.click(screen.getByRole('button', {name: '저장 대기 3'}));
    expect(screen.getByRole('dialog', {name: 'Activity & Sync'})).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', {name: 'Activity 닫기'}));
    expect(screen.queryByRole('dialog', {name: 'Activity & Sync'})).not.toBeInTheDocument();
  });

  it('enters selection mode and tracks selected library assets', () => {
    render(<PostAuthorityPreview/>);

    fireEvent.click(screen.getByRole('button', {name: '선택'}));
    expect(screen.getByText('0개 선택')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', {name: 'hikari · 17:42'}));
    expect(screen.getByText('1개 선택')).toBeInTheDocument();
    expect(screen.getByRole('button', {name: '앨범'})).toBeInTheDocument();
  });
});
