import { describe, it, expect } from 'bun:test'
import { applySectionSettings, sectionSettingsFromXml } from '../../src/packages/docx-engine/section'

describe('Section Page Borders Fidelity & Non-Destructive Update Suite', () => {
  const SAMPLE_SECT_PR_WITH_ART_BORDER = `<w:sectPr>
  <w:pgSz w:w="11906" w:h="16838"/>
  <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>
  <w:pgBorders w:offsetFrom="page" w:zOrder="back">
    <w:top w:val="apples" w:sz="24" w:space="24" w:color="auto"/>
    <w:left w:val="apples" w:sz="24" w:space="24" w:color="auto"/>
    <w:bottom w:val="apples" w:sz="24" w:space="24" w:color="auto"/>
    <w:right w:val="apples" w:sz="24" w:space="24" w:color="auto"/>
  </w:pgBorders>
  <w:cols w:space="708"/>
  <w:docGrid w:linePitch="360"/>
</w:sectPr>`

  it('1. Updating margins when pageBorder is undefined MUST NOT destroy existing w:pgBorders', () => {
    const originalSettings = sectionSettingsFromXml(SAMPLE_SECT_PR_WITH_ART_BORDER)
    expect(originalSettings.pageBorder).toBe(true)

    // Simulate updating only margins (pageBorder left undefined in update payload)
    const updatedXml = applySectionSettings(SAMPLE_SECT_PR_WITH_ART_BORDER, {
      ...originalSettings,
      marginTop: 2000,
      marginBottom: 2000,
      pageBorder: undefined, // caller did not alter border setting
    })

    // Assert that w:pgBorders is fully preserved with its original art attribute "apples"
    expect(updatedXml).toContain('<w:pgBorders')
    expect(updatedXml).toContain('w:val="apples"')
    expect(updatedXml).toContain('w:sz="24"')
    expect(updatedXml).toContain('w:top="2000"')
  })

  it('2. Explicitly disabling pageBorder (pageBorder: false) removes w:pgBorders', () => {
    const originalSettings = sectionSettingsFromXml(SAMPLE_SECT_PR_WITH_ART_BORDER)
    const updatedXml = applySectionSettings(SAMPLE_SECT_PR_WITH_ART_BORDER, {
      ...originalSettings,
      pageBorder: false,
    })

    expect(updatedXml).not.toContain('<w:pgBorders')
  })

  it('3. Enabling pageBorder (pageBorder: true) preserves existing borders if present, or creates default', () => {
    // Existing border preserved
    const updatedXmlPreserved = applySectionSettings(SAMPLE_SECT_PR_WITH_ART_BORDER, {
      ...sectionSettingsFromXml(SAMPLE_SECT_PR_WITH_ART_BORDER),
      pageBorder: true,
    })
    expect(updatedXmlPreserved).toContain('w:val="apples"')

    // Absent border created
    const SECT_PR_NO_BORDER = `<w:sectPr>
  <w:pgSz w:w="11906" w:h="16838"/>
  <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
</w:sectPr>`
    const updatedXmlCreated = applySectionSettings(SECT_PR_NO_BORDER, {
      ...sectionSettingsFromXml(SECT_PR_NO_BORDER),
      pageBorder: true,
    })
    expect(updatedXmlCreated).toContain('<w:pgBorders')
    expect(updatedXmlCreated).toContain('w:val="single"')
  })
})
