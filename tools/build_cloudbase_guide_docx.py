"""Build the shareable CloudBase beginner guide from its Markdown source."""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from typing import Iterable

from PIL import Image
from docx import Document
from docx.enum.section import WD_SECTION_START
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.opc.constants import RELATIONSHIP_TYPE
from docx.shared import Cm, Mm, Pt, RGBColor


BODY_FONT = "Microsoft YaHei"
CODE_FONT = "Consolas"
BLACK = "000000"
MUTED = "666666"
LINK = "0563C1"
TABLE_HEADER = "1F4E78"
TABLE_ALT = "EEF4F8"
TABLE_BORDER = "D9D9D9"
CODE_FILL = "F4F6F8"

INLINE_PATTERN = re.compile(
    r"(\*\*.+?\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))"
)
IMAGE_PATTERN = re.compile(r"^!\[([^\]]*)\]\(([^)]+)\)$")
HEADING_PATTERN = re.compile(r"^(#{1,3})\s+(.+?)\s*$")
ORDERED_PATTERN = re.compile(r"^(\d+)\.\s+(.+)$")


def set_run_font(run, name: str = BODY_FONT, size: float | None = None) -> None:
    run.font.name = name
    if size is not None:
        run.font.size = Pt(size)
    properties = run._element.get_or_add_rPr()
    fonts = properties.rFonts
    if fonts is None:
        fonts = OxmlElement("w:rFonts")
        properties.insert(0, fonts)
    for attribute in ("ascii", "hAnsi", "eastAsia", "cs"):
        fonts.set(qn(f"w:{attribute}"), name)


def set_cell_margins(cell, top: int = 90, start: int = 110, bottom: int = 90, end: int = 110) -> None:
    properties = cell._tc.get_or_add_tcPr()
    margins = properties.first_child_found_in("w:tcMar")
    if margins is None:
        margins = OxmlElement("w:tcMar")
        properties.append(margins)
    for edge, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = margins.find(qn(f"w:{edge}"))
        if node is None:
            node = OxmlElement(f"w:{edge}")
            margins.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def shade(element, fill: str) -> None:
    properties = element.get_or_add_tcPr() if hasattr(element, "get_or_add_tcPr") else element
    shading = properties.find(qn("w:shd"))
    if shading is None:
        shading = OxmlElement("w:shd")
        properties.append(shading)
    shading.set(qn("w:fill"), fill)


def set_table_borders(table) -> None:
    properties = table._tbl.tblPr
    borders = properties.find(qn("w:tblBorders"))
    if borders is None:
        borders = OxmlElement("w:tblBorders")
        properties.append(borders)
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        node = borders.find(qn(f"w:{edge}"))
        if node is None:
            node = OxmlElement(f"w:{edge}")
            borders.append(node)
        node.set(qn("w:val"), "single")
        node.set(qn("w:sz"), "6")
        node.set(qn("w:space"), "0")
        node.set(qn("w:color"), TABLE_BORDER)


def add_hyperlink(paragraph, text: str, url: str) -> None:
    relationship = paragraph.part.relate_to(
        url, RELATIONSHIP_TYPE.HYPERLINK, is_external=True
    )
    hyperlink = OxmlElement("w:hyperlink")
    hyperlink.set(qn("r:id"), relationship)
    run_element = OxmlElement("w:r")
    properties = OxmlElement("w:rPr")
    color = OxmlElement("w:color")
    color.set(qn("w:val"), LINK)
    underline = OxmlElement("w:u")
    underline.set(qn("w:val"), "single")
    fonts = OxmlElement("w:rFonts")
    for attribute in ("ascii", "hAnsi", "eastAsia", "cs"):
        fonts.set(qn(f"w:{attribute}"), BODY_FONT)
    properties.extend((fonts, color, underline))
    run_element.append(properties)
    text_element = OxmlElement("w:t")
    text_element.text = text
    run_element.append(text_element)
    hyperlink.append(run_element)
    paragraph._p.append(hyperlink)


def add_inline(paragraph, text: str, base_dir: Path) -> None:
    cursor = 0
    for match in INLINE_PATTERN.finditer(text):
        if match.start() > cursor:
            set_run_font(paragraph.add_run(text[cursor : match.start()]))
        token = match.group(0)
        if token.startswith("**"):
            run = paragraph.add_run(token[2:-2])
            run.bold = True
            set_run_font(run)
        elif token.startswith("`"):
            run = paragraph.add_run(token[1:-1])
            set_run_font(run, CODE_FONT, 9.5)
        else:
            label, target = re.fullmatch(r"\[([^\]]+)\]\(([^)]+)\)", token).groups()
            if target.startswith(("https://", "http://")):
                add_hyperlink(paragraph, label, target)
            else:
                set_run_font(paragraph.add_run(label))
                suffix = paragraph.add_run(f"（项目内文件 {target}）")
                suffix.font.color.rgb = RGBColor.from_string(MUTED)
                set_run_font(suffix, CODE_FONT, 8.5)
        cursor = match.end()
    if cursor < len(text):
        set_run_font(paragraph.add_run(text[cursor:]))


def clean_heading(text: str) -> str:
    replacements = {
        "CloudBase 免费资源优先部署：新手图文版": "CloudBase 免费资源优先部署新手图文版",
        "`windows.json` 14 个字段怎么看": "Windows 更新清单的 14 个字段",
        "“载入本项目示例”按钮的边界": "载入本项目示例按钮的边界",
        "环境 ID 到底填在哪里": "环境 ID 的填写位置",
    }
    text = replacements.get(text, text)
    text = re.sub(r"[`*_]", "", text)
    numbered_heading = re.match(r"^(\d+(?:\.\d+)*)\.?\s+(.*)$", text)
    if numbered_heading:
        number = numbered_heading.group(1).replace(".", " ")
        text = f"{number} {numbered_heading.group(2)}"
    text = re.sub(r"[：:！？!?]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def configure_document(document: Document) -> None:
    section = document.sections[0]
    section.start_type = WD_SECTION_START.NEW_PAGE
    section.page_width = Mm(210)
    section.page_height = Mm(297)
    section.top_margin = Mm(17)
    section.bottom_margin = Mm(16)
    section.left_margin = Mm(18)
    section.right_margin = Mm(18)
    section.header_distance = Mm(8)
    section.footer_distance = Mm(8)

    styles = document.styles
    normal = styles["Normal"]
    normal.font.name = BODY_FONT
    normal.font.size = Pt(10.5)
    normal.font.color.rgb = RGBColor.from_string(BLACK)
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), BODY_FONT)
    normal.paragraph_format.space_after = Pt(5)
    normal.paragraph_format.line_spacing = 1.25

    title = styles["Title"]
    title.font.name = BODY_FONT
    title.font.size = Pt(24)
    title.font.bold = True
    title.font.color.rgb = RGBColor.from_string(BLACK)
    title._element.rPr.rFonts.set(qn("w:eastAsia"), BODY_FONT)
    title.paragraph_format.space_after = Pt(12)
    title.paragraph_format.keep_with_next = True
    title_properties = title._element.get_or_add_pPr()
    title_border = title_properties.find(qn("w:pBdr"))
    if title_border is not None:
        title_properties.remove(title_border)

    heading_sizes = {1: 18, 2: 14, 3: 11.5}
    for level, size in heading_sizes.items():
        style = styles[f"Heading {level}"]
        style.font.name = BODY_FONT
        style.font.size = Pt(size)
        style.font.bold = True
        style.font.color.rgb = RGBColor.from_string(BLACK)
        style._element.rPr.rFonts.set(qn("w:eastAsia"), BODY_FONT)
        style.paragraph_format.space_before = Pt(14 if level == 1 else 10)
        style.paragraph_format.space_after = Pt(6)
        style.paragraph_format.keep_with_next = True

    if "Code Block" not in styles:
        code_style = styles.add_style("Code Block", 1)
    else:
        code_style = styles["Code Block"]
    code_style.font.name = CODE_FONT
    code_style.font.size = Pt(8.8)
    code_style._element.rPr.rFonts.set(qn("w:eastAsia"), BODY_FONT)
    code_style.paragraph_format.left_indent = Mm(4)
    code_style.paragraph_format.right_indent = Mm(2)
    code_style.paragraph_format.space_before = Pt(3)
    code_style.paragraph_format.space_after = Pt(7)
    code_style.paragraph_format.line_spacing = 1.05

    if "Figure Caption" not in styles:
        caption = styles.add_style("Figure Caption", 1)
    else:
        caption = styles["Figure Caption"]
    caption.font.name = BODY_FONT
    caption.font.size = Pt(8.5)
    caption.font.color.rgb = RGBColor.from_string(MUTED)
    caption._element.rPr.rFonts.set(qn("w:eastAsia"), BODY_FONT)
    caption.paragraph_format.space_before = Pt(2)
    caption.paragraph_format.space_after = Pt(9)

    document.core_properties.title = "CloudBase 免费资源优先部署新手图文版"
    document.core_properties.subject = "CloudBase 每日启动活跃统计和更新检查部署指南"
    document.core_properties.author = ""
    document.core_properties.last_modified_by = ""
    document.core_properties.comments = ""


def add_page_number(document: Document) -> None:
    paragraph = document.sections[0].footer.paragraphs[0]
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = paragraph.add_run("第 ")
    set_run_font(run, BODY_FONT, 8)
    run.font.color.rgb = RGBColor.from_string(MUTED)
    field_begin = OxmlElement("w:fldChar")
    field_begin.set(qn("w:fldCharType"), "begin")
    instruction = OxmlElement("w:instrText")
    instruction.set(qn("xml:space"), "preserve")
    instruction.text = " PAGE "
    field_end = OxmlElement("w:fldChar")
    field_end.set(qn("w:fldCharType"), "end")
    run._r.extend((field_begin, instruction, field_end))
    suffix = paragraph.add_run(" 页")
    suffix.font.color.rgb = RGBColor.from_string(MUTED)
    set_run_font(suffix, BODY_FONT, 8)


def add_list_item(document: Document, text: str, marker: str, base_dir: Path) -> None:
    paragraph = document.add_paragraph()
    paragraph.paragraph_format.left_indent = Mm(7)
    paragraph.paragraph_format.first_line_indent = Mm(-5)
    paragraph.paragraph_format.space_after = Pt(3)
    marker_run = paragraph.add_run(f"{marker} ")
    marker_run.bold = marker.endswith(".")
    set_run_font(marker_run)
    add_inline(paragraph, text, base_dir)


def add_code_block(document: Document, lines: list[str]) -> None:
    paragraph = document.add_paragraph(style="Code Block")
    properties = paragraph._p.get_or_add_pPr()
    shading = OxmlElement("w:shd")
    shading.set(qn("w:fill"), CODE_FILL)
    properties.append(shading)
    run = paragraph.add_run("\n".join(lines))
    set_run_font(run, CODE_FONT, 8.8)


def parse_table_row(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def is_separator_row(line: str) -> bool:
    cells = parse_table_row(line)
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells)


def table_widths(rows: list[list[str]], total_cm: float) -> list[float]:
    columns = max(len(row) for row in rows)
    scores = []
    for index in range(columns):
        lengths = [len(re.sub(r"[`*_]", "", row[index])) if index < len(row) else 0 for row in rows]
        scores.append(max(6, min(max(lengths, default=6), 42)))
    total_score = sum(scores)
    minimum = 1.45 if columns >= 4 else 1.7
    widths = [max(minimum, total_cm * score / total_score) for score in scores]
    scale = total_cm / sum(widths)
    return [width * scale for width in widths]


def add_table(document: Document, rows: list[list[str]], base_dir: Path) -> None:
    if not rows:
        return
    column_count = max(len(row) for row in rows)
    table = document.add_table(rows=len(rows), cols=column_count)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    widths = table_widths(rows, 17.2)
    set_table_borders(table)

    for row_index, row_data in enumerate(rows):
        row = table.rows[row_index]
        cant_split = OxmlElement("w:cantSplit")
        row._tr.get_or_add_trPr().append(cant_split)
        if row_index == 0:
            repeat = OxmlElement("w:tblHeader")
            repeat.set(qn("w:val"), "true")
            row._tr.get_or_add_trPr().append(repeat)
        for column_index, cell in enumerate(row.cells):
            cell.width = Cm(widths[column_index])
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
            set_cell_margins(cell)
            if row_index == 0:
                shade(cell._tc, TABLE_HEADER)
            elif row_index % 2 == 0:
                shade(cell._tc, TABLE_ALT)
            paragraph = cell.paragraphs[0]
            paragraph.paragraph_format.space_after = Pt(0)
            paragraph.paragraph_format.line_spacing = 1.12
            if column_index < len(row_data):
                add_inline(paragraph, row_data[column_index], base_dir)
            for run in paragraph.runs:
                set_run_font(run, BODY_FONT, 8.8)
                if row_index == 0:
                    run.bold = True
                    run.font.color.rgb = RGBColor(255, 255, 255)
    document.add_paragraph().paragraph_format.space_after = Pt(1)


def set_picture_alt(run, alt_text: str) -> None:
    for doc_property in run._element.xpath(".//wp:docPr"):
        doc_property.set("descr", alt_text)
        doc_property.set("title", alt_text)


def add_figure(document: Document, image_path: Path, alt_text: str) -> None:
    if not image_path.is_file():
        raise FileNotFoundError(f"Missing guide image: {image_path}")
    with Image.open(image_path) as image:
        width_px, height_px = image.size
    width_cm = min(17.2, max(8.0, width_px / 150 * 2.54))
    if height_px / width_px * width_cm > 21.5:
        width_cm = min(width_cm, 21.5 * width_px / height_px)
    paragraph = document.add_paragraph()
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    paragraph.paragraph_format.keep_with_next = True
    paragraph.paragraph_format.space_before = Pt(4)
    paragraph.paragraph_format.space_after = Pt(0)
    run = paragraph.add_run()
    run.add_picture(str(image_path), width=Cm(width_cm))
    set_picture_alt(run, alt_text)
    caption = document.add_paragraph(style="Figure Caption")
    caption.alignment = WD_ALIGN_PARAGRAPH.CENTER
    set_run_font(caption.add_run(f"图  {alt_text}"), BODY_FONT, 8.5)


def build_document(source: Path, output: Path) -> None:
    lines = source.read_text(encoding="utf-8").splitlines()
    document = Document()
    configure_document(document)
    add_page_number(document)
    base_dir = source.parent
    first_heading = True
    index = 0

    while index < len(lines):
        line = lines[index].rstrip()
        stripped = line.strip()
        if not stripped or stripped == "---":
            index += 1
            continue

        heading_match = HEADING_PATTERN.match(stripped)
        if heading_match:
            level = len(heading_match.group(1))
            heading_text = clean_heading(heading_match.group(2))
            if first_heading:
                paragraph = document.add_paragraph(style="Title")
                paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT
                paragraph_properties = paragraph._p.get_or_add_pPr()
                paragraph_border = paragraph_properties.find(qn("w:pBdr"))
                if paragraph_border is not None:
                    paragraph_properties.remove(paragraph_border)
                add_inline(paragraph, heading_text, base_dir)
                first_heading = False
            else:
                paragraph = document.add_paragraph(style=f"Heading {level}")
                add_inline(paragraph, heading_text, base_dir)
            index += 1
            continue

        image_match = IMAGE_PATTERN.match(stripped)
        if image_match:
            alt_text, relative_path = image_match.groups()
            add_figure(document, (base_dir / relative_path).resolve(), alt_text)
            index += 1
            continue

        if stripped.startswith("```"):
            code_lines: list[str] = []
            index += 1
            while index < len(lines) and not lines[index].strip().startswith("```"):
                code_lines.append(lines[index].rstrip())
                index += 1
            if index < len(lines):
                index += 1
            add_code_block(document, code_lines)
            continue

        if stripped.startswith("|") and index + 1 < len(lines) and is_separator_row(lines[index + 1]):
            table_rows = [parse_table_row(stripped)]
            index += 2
            while index < len(lines) and lines[index].strip().startswith("|"):
                table_rows.append(parse_table_row(lines[index]))
                index += 1
            add_table(document, table_rows, base_dir)
            continue

        if stripped.startswith("> "):
            paragraph = document.add_paragraph()
            paragraph.paragraph_format.left_indent = Mm(5)
            paragraph.paragraph_format.right_indent = Mm(3)
            paragraph.paragraph_format.space_after = Pt(8)
            add_inline(paragraph, stripped[2:], base_dir)
            for run in paragraph.runs:
                run.italic = True
                run.font.color.rgb = RGBColor.from_string(MUTED)
            index += 1
            continue

        ordered_match = ORDERED_PATTERN.match(stripped)
        if ordered_match:
            add_list_item(document, ordered_match.group(2), f"{ordered_match.group(1)}.", base_dir)
            index += 1
            continue

        if stripped.startswith(("- ", "* ")):
            add_list_item(document, stripped[2:], "•", base_dir)
            index += 1
            continue

        paragraph_lines = [stripped]
        index += 1
        while index < len(lines):
            candidate = lines[index].strip()
            if (
                not candidate
                or HEADING_PATTERN.match(candidate)
                or IMAGE_PATTERN.match(candidate)
                or candidate.startswith(("```", "> ", "- ", "* ", "|"))
                or ORDERED_PATTERN.match(candidate)
            ):
                break
            paragraph_lines.append(candidate)
            index += 1
        paragraph = document.add_paragraph()
        add_inline(paragraph, " ".join(paragraph_lines), base_dir)

    output.parent.mkdir(parents=True, exist_ok=True)
    document.save(output)


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    return parser.parse_args(argv)


def main() -> int:
    args = parse_args()
    build_document(args.source.resolve(), args.output.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
