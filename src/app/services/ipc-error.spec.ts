import { ipcErrorMessage } from '../../../shared/ipc-error';

describe('ipcErrorMessage', () => {
  it('strips the Electron remote-method wrapper and the Error prefixes', () => {
    expect(
      ipcErrorMessage(
        new Error(
          "Error invoking remote method 'thread:summarize': Error: No model is selected in settings.",
        ),
      ),
    ).toBe('No model is selected in settings.');
  });

  it('leaves an ordinary message untouched', () => {
    expect(ipcErrorMessage(new Error('Vault folder no longer exists: E:/x'))).toBe(
      'Vault folder no longer exists: E:/x',
    );
  });

  it('handles a thrown non-Error and an empty message', () => {
    expect(ipcErrorMessage('boom')).toBe('boom');
    expect(ipcErrorMessage(new Error('Error: '))).toBe('Something went wrong.');
  });
});
