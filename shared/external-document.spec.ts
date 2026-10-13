import { externalDocumentExtension, localFileHref } from './external-document';

describe('externalDocumentExtension', () => {
  it('recognises Office documents by name, vault path or absolute path', () => {
    expect(externalDocumentExtension('Report.DOCX')).toBe('docx');
    expect(externalDocumentExtension('docs/plan.v2.xlsx')).toBe('xlsx');
    expect(externalDocumentExtension('C:\\Docs\\deck.pptx')).toBe('pptx');
    expect(externalDocumentExtension('page.loop')).toBe('loop');
  });

  it('never matches an executable, a script, a shortcut or what Drey shows itself', () => {
    for (const name of ['setup.exe', 'run.bat', 'x.ps1', 'x.lnk', 'x.js', 'note.md', 'a.pdf', 'a.png']) {
      expect(externalDocumentExtension(name)).toBeNull();
    }
  });

  it('needs a real name before the extension', () => {
    expect(externalDocumentExtension('')).toBeNull();
    expect(externalDocumentExtension('docx')).toBeNull();
    expect(externalDocumentExtension('docs.docx/readme')).toBeNull();
    expect(externalDocumentExtension('docs/.docx')).toBeNull();
    expect(externalDocumentExtension('report.')).toBeNull();
  });
});

describe('localFileHref', () => {
  it('turns a Windows path into an encoded file link', () => {
    expect(localFileHref('C:\\Docs\\My report (v2) #1.docx')).toBe(
      'file:///C:/Docs/My%20report%20%28v2%29%20%231.docx',
    );
  });

  it('keeps a POSIX path rooted', () => {
    expect(localFileHref('/home/me/Größe.xlsx')).toBe('file:///home/me/Gr%C3%B6%C3%9Fe.xlsx');
  });

  it('refuses a network share, a relative path and an empty one', () => {
    expect(localFileHref('\\\\server\\share\\a.docx')).toBeNull();
    expect(localFileHref('//server/share/a.docx')).toBeNull();
    expect(localFileHref('docs/a.docx')).toBeNull();
    expect(localFileHref('')).toBeNull();
  });
});
