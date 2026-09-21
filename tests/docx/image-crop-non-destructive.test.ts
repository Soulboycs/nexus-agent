import { describe, it, expect } from 'bun:test'
import { patchImageParagraphXml } from '../../src/packages/docx-engine/generate'

describe('Non-Destructive Image Crop (<a:srcRect>) Test Suite', () => {
  const baseDrawingXml = 
    '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="1000000" cy="800000"/>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic><pic:blipFill><a:blip r:embed="rId5"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="800000"/></a:xfrm></pic:spPr></pic:pic>' +
    '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'

  it('1. patchImageParagraphXml injects <a:srcRect> with 100000-based fractional coordinates', () => {
    const patched = patchImageParagraphXml(baseDrawingXml, {
      crop: { l: 0.1, t: 0.15, r: 0.12, b: 0.08 },
    })

    expect(patched).toContain('<a:srcRect l="10000" t="15000" r="12000" b="8000"/>')
    expect(patched).toContain('<a:blip r:embed="rId5"/>')
  })

  it('2. patchImageParagraphXml updates existing <a:srcRect> without duplicating it', () => {
    const xmlWithCrop = baseDrawingXml.replace(
      '<a:blip r:embed="rId5"/>',
      '<a:blip r:embed="rId5"/><a:srcRect l="5000" t="5000" r="5000" b="5000"/>',
    )

    const updated = patchImageParagraphXml(xmlWithCrop, {
      crop: { l: 0.2, t: 0.25, r: 0.1, b: 0.05 },
    })

    expect(updated).toContain('<a:srcRect l="20000" t="25000" r="10000" b="5000"/>')
    expect(updated).not.toContain('l="5000"')
  })

  it('3. patchImageParagraphXml removes <a:srcRect> when crop is null (uncrop)', () => {
    const xmlWithCrop = baseDrawingXml.replace(
      '<a:blip r:embed="rId5"/>',
      '<a:blip r:embed="rId5"/><a:srcRect l="10000" t="10000" r="10000" b="10000"/>',
    )

    const uncropped = patchImageParagraphXml(xmlWithCrop, {
      crop: null,
    })

    expect(uncropped).not.toContain('<a:srcRect')
    expect(uncropped).toContain('<a:blip r:embed="rId5"/>')
  })
})
