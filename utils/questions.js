/**
 * utils/questions.js
 * 题库（本地 mock 数据，可直接替换为接口/题库文件导入）
 *
 * 字段说明：
 * id        题目唯一标识
 * subject   科目
 * chapter   知识点（章节）
 * type      single 单选 / multiple 多选 / judge 判断 / uncertain 不定项 / fill 填空 / sort 排序
 * level     难度 1-3
 * stem      题干（填空题用 ___ 标记空位）
 * options   选项 [{key, text}]，填空题无此字段
 * answer    单选/多选/判断/不定项：正确选项 key 数组
 *           填空：按空位顺序的答案数组，每项可为字符串或同义答案数组（如 [['应用层','应用']]）
 *           排序：正确顺序的 key 数组
 * explain   常规解析
 * pitfall   易错提示
 * keyPoint  核心考点
 * tags      标签，用于「举一反三」关联推荐
 */

const QUESTIONS = [
  /* ---------------- 公共基础知识 · 法律常识 ---------------- */
  {
    id: 'GK-LAW-01',
    subject: '公共基础知识',
    chapter: '法律常识',
    type: 'single',
    level: 1,
    stem: '我国现行宪法是哪一年颁布的？',
    options: [
      { key: 'A', text: '1954 年' },
      { key: 'B', text: '1975 年' },
      { key: 'C', text: '1978 年' },
      { key: 'D', text: '1982 年' }
    ],
    answer: ['D'],
    explain: '我国先后有过 1954 年、1975 年、1978 年和 1982 年四部宪法，现行宪法是 1982 年宪法，之后经多次部分修改。',
    pitfall: '容易误选 1954 年——那是我国第一部宪法，但不是现行宪法。',
    keyPoint: '宪法发展史：1954 首部 / 1982 现行。',
    tags: ['宪法']
  },
  {
    id: 'GK-LAW-02',
    subject: '公共基础知识',
    chapter: '法律常识',
    type: 'single',
    level: 2,
    stem: '下列社会关系中，属于我国民法调整范围的是：',
    options: [
      { key: 'A', text: '税务局向企业征收税款' },
      { key: 'B', text: '甲将自己的房屋出售给乙' },
      { key: 'C', text: '公安机关对违法行为人作出行政拘留决定' },
      { key: 'D', text: '人民检察院依法提起公诉' }
    ],
    answer: ['B'],
    explain: '民法调整平等主体的自然人、法人和非法人组织之间的人身关系和财产关系。房屋买卖属于平等主体之间的财产关系。税收、行政处罚、公诉均属于公法（行政法/刑法/诉讼法）调整的纵向管理关系。',
    pitfall: '注意「调整对象是否为平等主体」，只要出现管理与被管理、命令与服从，一般就不归民法调整。',
    keyPoint: '民法的调整对象：平等主体间的人身关系与财产关系。',
    tags: ['民法', '法律关系']
  },
  {
    id: 'GK-LAW-03',
    subject: '公共基础知识',
    chapter: '法律常识',
    type: 'single',
    level: 2,
    stem: '下列不属于行政处罚种类的是：',
    options: [
      { key: 'A', text: '警告' },
      { key: 'B', text: '罚款' },
      { key: 'C', text: '拘役' },
      { key: 'D', text: '吊销许可证件' }
    ],
    answer: ['C'],
    explain: '拘役是我国刑法规定的主刑之一，由人民法院判处，属于刑事处罚；警告、罚款、吊销许可证件属于行政处罚。',
    pitfall: '「行政拘留」是行政处罚，「拘役」是刑罚，一字之差性质完全不同。',
    keyPoint: '行政处罚 vs 刑罚的区分。',
    tags: ['行政法', '行政处罚']
  },
  {
    id: 'GK-LAW-04',
    subject: '公共基础知识',
    chapter: '法律常识',
    type: 'multiple',
    level: 3,
    stem: '依据我国《民法典》，下列属于民事权利的有：',
    options: [
      { key: 'A', text: '生命权' },
      { key: 'B', text: '名誉权' },
      { key: 'C', text: '选举权' },
      { key: 'D', text: '隐私权' }
    ],
    answer: ['A', 'B', 'D'],
    explain: '《民法典》确认了生命权、身体权、健康权、名誉权、隐私权等人身权与各类财产权；选举权属于公民的政治权利，由宪法和选举法规定，不属于民事权利。',
    pitfall: '多选题先做「属性归类」：民事权利看是否属于人身/财产范畴，政治权利另行投放。',
    keyPoint: '民事权利的分类：人身权、财产权等综合性权利。',
    tags: ['民法典', '民事权利']
  },

  /* ---------------- 公共基础知识 · 公文写作 ---------------- */
  {
    id: 'GK-GW-01',
    subject: '公共基础知识',
    chapter: '公文写作',
    type: 'single',
    level: 1,
    stem: '公文标题一般由哪三个要素组成？',
    options: [
      { key: 'A', text: '发文机关名称、事由、文种' },
      { key: 'B', text: '主送机关、正文、落款' },
      { key: 'C', text: '发文日期、密级、编号' },
      { key: 'D', text: '抄送单位、附件、主题词' }
    ],
    answer: ['A'],
    explain: '规范的公文标题由「发文机关名称＋事由＋文种」三要素构成，例如《XX市人民政府关于加强安全生产工作的通知》。',
    pitfall: '标题三要素与正文结构要素不要混淆。',
    keyPoint: '公文标题三要素。',
    tags: ['公文格式']
  },
  {
    id: 'GK-GW-02',
    subject: '公共基础知识',
    chapter: '公文写作',
    type: 'single',
    level: 2,
    stem: '适用于表彰先进、批评错误、传达重要精神的公文文种是：',
    options: [
      { key: 'A', text: '通知' },
      { key: 'B', text: '通报' },
      { key: 'C', text: '报告' },
      { key: 'D', text: '函' }
    ],
    answer: ['B'],
    explain: '「通报」适用于表彰先进、批评错误、传达重要精神或情况；通知用于发布、传达要求执行或周知的事项；报告用于向上级汇报；函用于不相隶属机关之间商洽。',
    pitfall: '「通知」重在办事，「通报」重在宣传教育，这是两者最常见的区分点。',
    keyPoint: '常用法定文种的适用范围。',
    tags: ['文种辨析']
  },
  {
    id: 'GK-GW-03',
    subject: '公共基础知识',
    chapter: '公文写作',
    type: 'single',
    level: 2,
    stem: '关于请示的写作要求，下列说法正确的是：',
    options: [
      { key: 'A', text: '可以一文多事以提高效率' },
      { key: 'B', text: '应当一文一事，事前行文' },
      { key: 'C', text: '可以直接报送领导者个人' },
      { key: 'D', text: '可以同时抄送下级机关执行' }
    ],
    answer: ['B'],
    explain: '请示要求一文一事、事前行文、单头主送（一般不抄送下级），不得直接送领导个人；一文多事会造成批办困难。',
    pitfall: '请示是「事前」，报告是「事后/事中」，二者行文时间常被混用。',
    keyPoint: '请示的写作规则：一文一事、事前、单头主送。',
    tags: ['请示', '行文规则']
  },

  /* ---------------- 公共基础知识 · 经济管理 ---------------- */
  {
    id: 'GK-ECO-01',
    subject: '公共基础知识',
    chapter: '经济管理',
    type: 'single',
    level: 1,
    stem: '通货膨胀最直接的表现是：',
    options: [
      { key: 'A', text: '物价总水平持续普遍上涨' },
      { key: 'B', text: '失业率持续上升' },
      { key: 'C', text: '本国货币汇率上升' },
      { key: 'D', text: '居民储蓄大幅增加' }
    ],
    answer: ['A'],
    explain: '通货膨胀指物价总水平在一段时间内持续、普遍上涨的经济现象，其实质是社会总需求大于总供给。',
    pitfall: '个别商品涨价不等于通货膨胀，必须是「物价总水平」且「持续」上涨。',
    keyPoint: '通货膨胀的含义与衡量。',
    tags: ['宏观经济']
  },
  {
    id: 'GK-ECO-02',
    subject: '公共基础知识',
    chapter: '经济管理',
    type: 'single',
    level: 2,
    stem: '国内生产总值（GDP）是指：',
    options: [
      { key: 'A', text: '一定时期内本国常住单位生产的全部最终产品和服务的价值' },
      { key: 'B', text: '本国公民在国内外取得的全部收入之和' },
      { key: 'C', text: '全社会所有商品的销售总额' },
      { key: 'D', text: '国家财政收入与支出之和' }
    ],
    answer: ['A'],
    explain: 'GDP 按国土原则统计，是一定时期内一国（或地区）所有常住单位生产的全部最终产品和服务的价值；按国民原则统计的是 GNP/GNI。',
    pitfall: 'GDP 看「地域」，GNP 看「国籍」，两者统计口径不同。',
    keyPoint: 'GDP 与 GNP 的统计口径差异。',
    tags: ['宏观经济指标']
  },
  {
    id: 'GK-ECO-03',
    subject: '公共基础知识',
    chapter: '经济管理',
    type: 'single',
    level: 1,
    stem: '在其他条件不变的情况下，某商品供不应求时，其市场价格一般会：',
    options: [
      { key: 'A', text: '上涨' },
      { key: 'B', text: '下跌' },
      { key: 'C', text: '保持不变' },
      { key: 'D', text: '先跌后涨' }
    ],
    answer: ['A'],
    explain: '供求影响价格：供不应求时买方竞争推高价格；供过于求时卖方竞争导致价格下跌。',
    pitfall: '题目默认前提是「其他条件不变」——若设定了政府限价则另当别论。',
    keyPoint: '供求规律对价格的影响。',
    tags: ['微观经济']
  },

  /* ---------------- 公共基础知识 · 科技人文 ---------------- */
  {
    id: 'GK-SCI-01',
    subject: '公共基础知识',
    chapter: '科技人文',
    type: 'single',
    level: 2,
    stem: '二十四节气中最早被确定的两个节气是：',
    options: [
      { key: 'A', text: '立春、立夏' },
      { key: 'B', text: '冬至、夏至' },
      { key: 'C', text: '春分、秋分' },
      { key: 'D', text: '惊蛰、清明' }
    ],
    answer: ['B'],
    explain: '古人通过观测日影长短最早确定了冬至（日影最长）和夏至（日影最短），随后才确定春分、秋分。',
    pitfall: '不要按时间顺序想当然选立春——立春是首个节气但不是最早确定的。',
    keyPoint: '二十四节气的形成过程。',
    tags: ['传统文化']
  },
  {
    id: 'GK-SCI-02',
    subject: '公共基础知识',
    chapter: '科技人文',
    type: 'single',
    level: 1,
    stem: '我国成功发射的第一颗人造地球卫星是：',
    options: [
      { key: 'A', text: '神舟一号' },
      { key: 'B', text: '东方红一号' },
      { key: 'C', text: '嫦娥一号' },
      { key: 'D', text: '风云一号' }
    ],
    answer: ['B'],
    explain: '东方红一号于 1970 年发射成功，是我国第一颗人造地球卫星；神舟一号是载人航天试验飞船，嫦娥一号是月球探测器。',
    pitfall: '注意区分「卫星、飞船、探测器」三类航天器。',
    keyPoint: '我国航天里程碑事件。',
    tags: ['科技成就']
  },
  {
    id: 'GK-SCI-03',
    subject: '公共基础知识',
    chapter: '科技人文',
    type: 'single',
    level: 1,
    stem: '下列现象中，主要由光的折射形成的是：',
    options: [
      { key: 'A', text: '水中的倒影' },
      { key: 'B', text: '插入水中的筷子看上去弯折' },
      { key: 'C', text: '阳光下树木的影子' },
      { key: 'D', text: '平面镜成像' }
    ],
    answer: ['B'],
    explain: '筷子在水中看起来弯折是光从水进入空气时传播方向改变（折射）造成的；倒影与平面镜成像是反射，影子是光的直线传播。',
    pitfall: '做题时先判断「光是否跨越了不同介质」，跨越介质才谈折射。',
    keyPoint: '光的直线传播、反射、折射三类现象辨析。',
    tags: ['物理常识']
  },
  {
    id: 'GK-SCI-04',
    subject: '公共基础知识',
    chapter: '科技人文',
    type: 'multiple',
    level: 2,
    stem: '下列属于可再生能源的有：',
    options: [
      { key: 'A', text: '太阳能' },
      { key: 'B', text: '风能' },
      { key: 'C', text: '煤炭' },
      { key: 'D', text: '水能' }
    ],
    answer: ['A', 'B', 'D'],
    explain: '可再生能源指可循环利用、短期内能再生的能源，如太阳能、风能、水能、生物质能等；煤炭属于不可再生的化石能源。',
    pitfall: '核能虽然清洁但不属于可再生能源（核燃料储量有限）。',
    keyPoint: '能源分类：可再生 vs 不可再生。',
    tags: ['能源常识']
  },

  /* ---------------- 职业能力测验 · 言语理解 ---------------- */
  {
    id: 'NL-VER-01',
    subject: '职业能力测验',
    chapter: '言语理解',
    type: 'single',
    level: 2,
    stem: '依次填入划横线部分最恰当的一项是：他在会上侃侃而谈，观点鲜明、论据充分，令人________。',
    options: [
      { key: 'A', text: '侧目' },
      { key: 'B', text: '刮目' },
      { key: 'C', text: '注目' },
      { key: 'D', text: '信服' }
    ],
    answer: ['D'],
    explain: '语境强调发言有说服力，故用「令人信服」最贴切。「侧目」含畏惧或愤恨色彩；「刮目」指改变旧看法；「注目」仅指把视线集中过去。',
    pitfall: '成语题先看感情色彩，再看搭配对象。',
    keyPoint: '实词辨析：结合语境感情色彩。',
    tags: ['实词辨析']
  },
  {
    id: 'NL-VER-02',
    subject: '职业能力测验',
    chapter: '言语理解',
    type: 'single',
    level: 2,
    stem: '下列句子中，没有语病的一项是：',
    options: [
      { key: 'A', text: '通过这次学习，使我明白了团队合作的重要性。' },
      { key: 'B', text: '能否提高成绩，取决于我们付出了足够的努力。' },
      { key: 'C', text: '经过反复练习，他的写作水平有了明显提高。' },
      { key: 'D', text: '为了防止不再发生类似事故，学校加强了安全教育。' }
    ],
    answer: ['C'],
    explain: 'A 项「通过……使……」滥用介词导致主语残缺；B 项「能否」与一面表述不照应；D 项「防止不再」否定不当。C 项表述完整规范。',
    pitfall: '病句辨析高频三类：成分残缺、搭配不当、否定不当。',
    keyPoint: '常见病句类型识别。',
    tags: ['病句辨析']
  },
  {
    id: 'NL-VER-03',
    subject: '职业能力测验',
    chapter: '言语理解',
    type: 'single',
    level: 1,
    stem: '互联网让信息传播变得极为便捷，也让谣言获得了更快的扩散速度。作者意在说明：',
    options: [
      { key: 'A', text: '互联网弊大于利，应当谨慎使用' },
      { key: 'B', text: '应辩证看待信息传播便捷带来的双面效应' },
      { key: 'C', text: '谣言全部产生于互联网' },
      { key: 'D', text: '技术进步是谣言产生的根本原因' }
    ],
    answer: ['B'],
    explain: '文段为并列结构，先讲便利再讲风险，作者强调的重点是对同一事物的双面效应保持清醒，而非简单否定互联网。',
    pitfall: '主旨题忌过度推断，含「全部、根本、应当禁止」等绝对化表述的选项通常不成立。',
    keyPoint: '主旨概括：并列结构取「合」而非「偏」。',
    tags: ['主旨概括']
  },

  /* ---------------- 职业能力测验 · 数量关系 ---------------- */
  {
    id: 'NL-NUM-01',
    subject: '职业能力测验',
    chapter: '数量关系',
    type: 'single',
    level: 1,
    stem: '某商品原价 200 元，先提价 10%，再降价 10%，此时价格为：',
    options: [
      { key: 'A', text: '200 元' },
      { key: 'B', text: '202 元' },
      { key: 'C', text: '198 元' },
      { key: 'D', text: '196 元' }
    ],
    answer: ['C'],
    explain: '200×1.1 = 220 元，220×0.9 = 198 元。涨跌幅相同但基数不同，结果必然低于原价。',
    pitfall: '「先涨 x% 再降 x%」不等于回到原价，结果永远比原价低 x²%。',
    keyPoint: '百分数变化：注意基数切换。',
    tags: ['利润问题']
  },
  {
    id: 'NL-NUM-02',
    subject: '职业能力测验',
    chapter: '数量关系',
    type: 'single',
    level: 2,
    stem: '一项工程，甲单独完成需 10 天，乙单独完成需 15 天，两人合作完成需要：',
    options: [
      { key: 'A', text: '5 天' },
      { key: 'B', text: '6 天' },
      { key: 'C', text: '8 天' },
      { key: 'D', text: '12 天' }
    ],
    answer: ['B'],
    explain: '设工程总量为 30（10 与 15 的最小公倍数），甲效率 3，乙效率 2，合作效率 5，所需时间 30÷5 = 6 天。',
    pitfall: '工程问题优先赋值「总量为工作时间的最小公倍数」，可大幅简化计算。',
    keyPoint: '工程问题：赋值总量法。',
    tags: ['工程问题']
  },
  {
    id: 'NL-NUM-03',
    subject: '职业能力测验',
    chapter: '数量关系',
    type: 'single',
    level: 2,
    stem: '数列 2，6，12，20，30，（　）的下一项是：',
    options: [
      { key: 'A', text: '40' },
      { key: 'B', text: '42' },
      { key: 'C', text: '44' },
      { key: 'D', text: '48' }
    ],
    answer: ['B'],
    explain: '各项可写为 1×2、2×3、3×4、4×5、5×6，下一项为 6×7 = 42；也可看作差数列 4、6、8、10、12 逐项累加。',
    pitfall: '数字推理先看「逐差」，再看「因式分解/平方」两种高频规律。',
    keyPoint: '数字推理：作差法与通项法。',
    tags: ['数字推理']
  },

  /* ---------------- 职业能力测验 · 判断推理 ---------------- */
  {
    id: 'NL-LOG-01',
    subject: '职业能力测验',
    chapter: '判断推理',
    type: 'single',
    level: 2,
    stem: '所有专业技术岗位都要求持证上岗，小李所在的岗位要求持证上岗。由此可以推出：',
    options: [
      { key: 'A', text: '小李一定是专业技术人员' },
      { key: 'B', text: '小李一定不是专业技术人员' },
      { key: 'C', text: '小李所在岗位一定是专业技术岗位' },
      { key: 'D', text: '无法确定小李所在岗位是否为专业技术岗位' }
    ],
    answer: ['D'],
    explain: '题干为「A→B」，已知 B 成立，属于肯定后件，无法必然推出 A。这是典型的逻辑谬误（肯定后件）。',
    pitfall: '只有「否定后件」或「肯定前件」才能得必然结论，肯定后件、否定前件都推不出。',
    keyPoint: '假言命题推理规则。',
    tags: ['逻辑推理']
  },
  {
    id: 'NL-LOG-02',
    subject: '职业能力测验',
    chapter: '判断推理',
    type: 'single',
    level: 1,
    stem: '指南针：方向，与下列哪组词逻辑关系最为相似？',
    options: [
      { key: 'A', text: '温度计：水银' },
      { key: 'B', text: '刻度尺：刻度' },
      { key: 'C', text: '体重秤：重量' },
      { key: 'D', text: '望远镜：镜片' }
    ],
    answer: ['C'],
    explain: '题干关系是「工具：测量对象」，指南针测量方向，体重秤测量重量。A、B、D 后项均为工具的组成或配套要素。',
    pitfall: '类比题要先确定关系的「类型与方向」，再逐项排除，切莫只看词性。',
    keyPoint: '类比推理：工具与作用对象。',
    tags: ['类比推理']
  },
  {
    id: 'NL-LOG-03',
    subject: '职业能力测验',
    chapter: '判断推理',
    type: 'single',
    level: 2,
    stem: '某班凡喜欢篮球的同学都不喜欢足球，小张喜欢足球。由此可以推出：',
    options: [
      { key: 'A', text: '小张喜欢篮球' },
      { key: 'B', text: '小张不喜欢篮球' },
      { key: 'C', text: '有些喜欢足球的同学喜欢篮球' },
      { key: 'D', text: '无法确定' }
    ],
    answer: ['B'],
    explain: '「喜欢篮球 → 不喜欢足球」的逆否命题是「喜欢足球 → 不喜欢篮球」，小张喜欢足球，故必然不喜欢篮球。',
    pitfall: '原命题与其逆否命题等价，这是解此类题最快的方法。',
    keyPoint: '逆否命题的等价转化。',
    tags: ['逻辑推理']
  },

  /* ---------------- 职业能力测验 · 资料分析 ---------------- */
  {
    id: 'NL-DAT-01',
    subject: '职业能力测验',
    chapter: '资料分析',
    type: 'single',
    level: 2,
    stem: '某市第一季度地区生产总值为 1200 亿元，第二季度为 1500 亿元。第二季度环比增长率为：',
    options: [
      { key: 'A', text: '15%' },
      { key: 'B', text: '20%' },
      { key: 'C', text: '25%' },
      { key: 'D', text: '30%' }
    ],
    answer: ['C'],
    explain: '环比增长率 =（本期－上期）÷ 上期 =（1500－1200）÷ 1200 = 25%。环比是与紧邻的上一个统计周期相比。',
    pitfall: '环比看上一期，同比看去年同期，分母千万别取错。',
    keyPoint: '增长率：同比与环比的区别。',
    tags: ['增长率']
  },
  {
    id: 'NL-DAT-02',
    subject: '职业能力测验',
    chapter: '资料分析',
    type: 'single',
    level: 1,
    stem: '某企业 2023 年营业收入 800 万元，其中线上收入 320 万元，线上收入占总收入的比重为：',
    options: [
      { key: 'A', text: '32%' },
      { key: 'B', text: '40%' },
      { key: 'C', text: '45%' },
      { key: 'D', text: '48%' }
    ],
    answer: ['B'],
    explain: '比重 = 部分 ÷ 整体 = 320 ÷ 800 = 40%。',
    pitfall: '比重题务必确认整体口径，避免把部分与部分相除。',
    keyPoint: '比重的基本计算。',
    tags: ['比重']
  },
  {
    id: 'NL-DAT-03',
    subject: '职业能力测验',
    chapter: '资料分析',
    type: 'single',
    level: 1,
    stem: '某地区 2022 年末人口为 500 万人，2023 年人口自然增长率为 2%，则 2023 年末人口约为：',
    options: [
      { key: 'A', text: '505 万人' },
      { key: 'B', text: '510 万人' },
      { key: 'C', text: '515 万人' },
      { key: 'D', text: '520 万人' }
    ],
    answer: ['B'],
    explain: '末期值 = 初期值 ×（1＋增长率）= 500 × 1.02 = 510 万人。',
    pitfall: '增长率是相对量，不能直接与绝对量相加减。',
    keyPoint: '现期值＝基期值×（1＋增长率）。',
    tags: ['增长量计算']
  },

  /* ---------------- 专业知识 · 操作系统 ---------------- */
  {
    id: 'IT-OS-01',
    subject: '专业知识',
    chapter: '操作系统',
    type: 'single',
    level: 2,
    stem: '关于进程与线程，下列说法正确的是：',
    options: [
      { key: 'A', text: '进程是 CPU 调度的基本单位' },
      { key: 'B', text: '线程拥有完全独立的地址空间' },
      { key: 'C', text: '一个进程中可以包含多个线程' },
      { key: 'D', text: '线程之间不能共享任何资源' }
    ],
    answer: ['C'],
    explain: '线程是 CPU 调度的基本单位，进程是资源分配的基本单位；同一进程内的多个线程共享进程的地址空间和资源，各自拥有独立的栈与寄存器上下文。',
    pitfall: '「调度」对线程，「分配资源」对进程，两句话务必配套记忆。',
    keyPoint: '进程与线程的关系与区别。',
    tags: ['进程管理']
  },
  {
    id: 'IT-OS-02',
    subject: '专业知识',
    chapter: '操作系统',
    type: 'single',
    level: 2,
    stem: '下列各项中，不属于产生死锁必要条件的是：',
    options: [
      { key: 'A', text: '互斥条件' },
      { key: 'B', text: '占有且等待条件' },
      { key: 'C', text: '资源可被抢占条件' },
      { key: 'D', text: '循环等待条件' }
    ],
    answer: ['C'],
    explain: '死锁的四个必要条件是：互斥、占有且等待、不可抢占、循环等待。资源可被抢占反而有助于解除死锁，因此不是必要条件。',
    pitfall: '必要条件是「不可抢占」而非「可抢占」，注意否定词的差异。',
    keyPoint: '死锁四必要条件。',
    tags: ['死锁']
  },
  {
    id: 'IT-OS-03',
    subject: '专业知识',
    chapter: '操作系统',
    type: 'single',
    level: 1,
    stem: '引入虚拟内存技术的主要目的是：',
    options: [
      { key: 'A', text: '提高 CPU 主频' },
      { key: 'B', text: '在逻辑上扩充内存，使更大的程序得以运行' },
      { key: 'C', text: '替代高速缓存 Cache' },
      { key: 'D', text: '加快磁盘的物理读写速度' }
    ],
    answer: ['B'],
    explain: '虚拟内存把磁盘作为内存的延伸，让进程在远大于实际物理内存的逻辑地址空间中运行，由操作系统负责页面调入调出。',
    pitfall: '虚拟内存并不提高任何硬件速度，反而可能因缺页中断带来额外开销。',
    keyPoint: '虚拟内存的作用与实现原理。',
    tags: ['内存管理']
  },

  /* ---------------- 专业知识 · 网络基础 ---------------- */
  {
    id: 'IT-NET-01',
    subject: '专业知识',
    chapter: '网络基础',
    type: 'single',
    level: 2,
    stem: '在 OSI 参考模型中，负责路由选择与 IP 寻址的是：',
    options: [
      { key: 'A', text: '数据链路层' },
      { key: 'B', text: '网络层' },
      { key: 'C', text: '传输层' },
      { key: 'D', text: '会话层' }
    ],
    answer: ['B'],
    explain: '网络层负责逻辑寻址（IP）与路由选择；数据链路层负责相邻节点的帧传输与 MAC 寻址；传输层负责端到端可靠传输（TCP/UDP）。',
    pitfall: '「相邻节点」→链路层，「端到端」→传输层，「跨网络选路」→网络层。',
    keyPoint: 'OSI 七层模型各层职责。',
    tags: ['网络模型']
  },
  {
    id: 'IT-NET-02',
    subject: '专业知识',
    chapter: '网络基础',
    type: 'single',
    level: 2,
    stem: '关于 TCP 与 UDP，下列说法正确的是：',
    options: [
      { key: 'A', text: 'TCP 不保证数据的可靠到达' },
      { key: 'B', text: 'UDP 是面向连接的协议' },
      { key: 'C', text: 'TCP 提供流量控制与拥塞控制机制' },
      { key: 'D', text: 'UDP 通过三次握手建立连接' }
    ],
    answer: ['C'],
    explain: 'TCP 面向连接、可靠、有序，并提供流量控制与拥塞控制；UDP 无连接、尽最大努力交付，开销小但不保证可靠。',
    pitfall: '把可靠性放在第一位选 TCP，把实时性与低开销放在第一位选 UDP。',
    keyPoint: 'TCP 与 UDP 的特性对比。',
    tags: ['传输层协议']
  },
  {
    id: 'IT-NET-03',
    subject: '专业知识',
    chapter: '网络基础',
    type: 'single',
    level: 1,
    stem: '用于将域名转换为 IP 地址的协议是：',
    options: [
      { key: 'A', text: 'HTTP' },
      { key: 'B', text: 'DNS' },
      { key: 'C', text: 'FTP' },
      { key: 'D', text: 'SMTP' }
    ],
    answer: ['B'],
    explain: 'DNS（域名系统）完成域名到 IP 地址的解析；HTTP 用于网页传输，FTP 用于文件传输，SMTP 用于邮件发送。',
    pitfall: '记住各协议的功能定位即可秒杀此类识记题。',
    keyPoint: '常见应用层协议的功能。',
    tags: ['应用层协议']
  },

  /* ---------------- 专业知识 · 数据库 ---------------- */
  {
    id: 'IT-DB-01',
    subject: '专业知识',
    chapter: '数据库',
    type: 'single',
    level: 1,
    stem: '在关系数据库中，能够唯一标识一条记录并保证不重复的字段称为：',
    options: [
      { key: 'A', text: '外键' },
      { key: 'B', text: '主键' },
      { key: 'C', text: '索引' },
      { key: 'D', text: '视图' }
    ],
    answer: ['B'],
    explain: '主键唯一标识表中的每一条记录且不能重复、不能为空；外键用于建立表间联系，索引用于提升查询效率，视图是虚拟表。',
    pitfall: '索引用于「提速」，主键用于「唯一标识」，不要混用两者的职责。',
    keyPoint: '关系数据库完整性约束。',
    tags: ['基本概念']
  },
  {
    id: 'IT-DB-02',
    subject: '专业知识',
    chapter: '数据库',
    type: 'single',
    level: 2,
    stem: 'SQL 语句 SELECT * FROM student WHERE age > 20 ORDER BY score DESC 表示：',
    options: [
      { key: 'A', text: '查询年龄大于 20 的学生，并按成绩升序排列' },
      { key: 'B', text: '查询年龄大于 20 的学生，并按成绩降序排列' },
      { key: 'C', text: '查询成绩最高的学生信息' },
      { key: 'D', text: '先按年龄排序，再筛选 20 岁以上学生' }
    ],
    answer: ['B'],
    explain: 'WHERE 用于筛选，ORDER BY 指定排序字段，DESC 表示降序（ASC 为升序）。',
    pitfall: 'DESC = 降序（从大到小），ASC = 升序；SQL 中先 WHERE 筛选再 ORDER BY 排序。',
    keyPoint: 'SELECT 语句的子句执行顺序。',
    tags: ['SQL']
  },
  {
    id: 'IT-DB-03',
    subject: '专业知识',
    chapter: '数据库',
    type: 'single',
    level: 2,
    stem: '事务的 ACID 特性中，字母 C 代表的是：',
    options: [
      { key: 'A', text: '原子性' },
      { key: 'B', text: '一致性' },
      { key: 'C', text: '隔离性' },
      { key: 'D', text: '持久性' }
    ],
    answer: ['B'],
    explain: 'ACID 分别指 Atomicity（原子性）、Consistency（一致性）、Isolation（隔离性）、Durability（持久性）。',
    pitfall: '注意英文首字母对应关系：A 原子、C 一致、I 隔离、D 持久。',
    keyPoint: '事务的四大特性。',
    tags: ['事务']
  },

  /* ---------------- 专业知识 · 信息安全 ---------------- */
  {
    id: 'IT-SEC-01',
    subject: '专业知识',
    chapter: '信息安全',
    type: 'single',
    level: 2,
    stem: '下列属于对称加密算法的是：',
    options: [
      { key: 'A', text: 'RSA' },
      { key: 'B', text: 'AES' },
      { key: 'C', text: 'ECC' },
      { key: 'D', text: 'DSA' }
    ],
    answer: ['B'],
    explain: '对称加密的加解密使用同一密钥，典型算法有 AES、DES、3DES；RSA、ECC、DSA 都属于非对称加密或签名算法。',
    pitfall: '对称＝同一把钥匙，实际業務中常用于大量数据的加密。',
    keyPoint: '对称加密与非对称加密的区别。',
    tags: ['密码学基础']
  },
  {
    id: 'IT-SEC-02',
    subject: '专业知识',
    chapter: '信息安全',
    type: 'single',
    level: 2,
    stem: '关于哈希算法（如 MD5、SHA 系列），下列说法错误的是：',
    options: [
      { key: 'A', text: '具有单向性，通常难以由摘要还原原文' },
      { key: 'B', text: '无论输入多长，输出长度固定' },
      { key: 'C', text: '可以使用相同密钥把摘要还原为原文' },
      { key: 'D', text: '理想情况下应具有较强的抗碰撞能力' }
    ],
    answer: ['C'],
    explain: '哈希是单向不可逆的压缩映射，不存在「密钥」概念，也无法从摘要解密出原文；它常用于完整性校验与口令摘要存储。',
    pitfall: '加密可以解密（对称/非对称），哈希只能校验不能还原。',
    keyPoint: '哈希算法的三大特征。',
    tags: ['密码学基础']
  },
  {
    id: 'IT-SEC-03',
    subject: '专业知识',
    chapter: '信息安全',
    type: 'single',
    level: 1,
    stem: '下列措施中，对防范弱口令攻击最有效的是：',
    options: [
      { key: 'A', text: '定期更换显示器' },
      { key: 'B', text: '使用复杂度足够的口令并开启双因素认证' },
      { key: 'C', text: '关闭系统防火墙以减少暴露面' },
      { key: 'D', text: '多人共享同一个账号便于管理' }
    ],
    answer: ['B'],
    explain: '提高口令复杂度并启用双因素认证（如短信/动态口令/硬件密钥）可显著降低口令被爆破或撞库的风险。',
    pitfall: '共享账号会破坏可追溯性，是账号管理的大忌。',
    keyPoint: '身份认证加固措施。',
    tags: ['安全防护']
  },
  {
    id: 'IT-SEC-04',
    subject: '专业知识',
    chapter: '信息安全',
    type: 'multiple',
    level: 2,
    stem: '下列属于人工智能典型应用的有：',
    options: [
      { key: 'A', text: '语音识别' },
      { key: 'B', text: '机器翻译' },
      { key: 'C', text: '推荐系统' },
      { key: 'D', text: '数据定时备份' }
    ],
    answer: ['A', 'B', 'C'],
    explain: '语音识别、机器翻译、推荐系统均依赖机器学习模型完成感知或决策；数据定时备份属于运维容灾手段，与人工智能无关。',
    pitfall: '判断标准是系统是否具备「从数据中学习并预测」的能力。',
    keyPoint: '人工智能典型应用场景。',
    tags: ['前沿技术']
  },

  /* ---------------- 判断题 ---------------- */
  {
    id: 'GK-LAW-J1',
    subject: '公共基础知识',
    chapter: '法律常识',
    type: 'judge',
    level: 1,
    stem: '宪法是国家的根本大法，具有最高的法律效力。',
    options: [
      { key: 'A', text: '正确' },
      { key: 'B', text: '错误' }
    ],
    answer: ['A'],
    explain: '宪法规定国家的根本制度和根本任务，是其他法律的立法基础，一切法律、行政法规和地方性法规都不得同宪法相抵触。',
    pitfall: '注意「根本大法」与「最高法律效力」是宪法的两个固定表述。',
    keyPoint: '宪法的根本法地位。',
    tags: ['宪法']
  },
  {
    id: 'GK-WRIT-J1',
    subject: '公共基础知识',
    chapter: '公文写作',
    type: 'judge',
    level: 2,
    stem: '请示可以一文多事，以便提高办事效率。',
    options: [
      { key: 'A', text: '正确' },
      { key: 'B', text: '错误' }
    ],
    answer: ['B'],
    explain: '请示应当一文一事，一份请示只提出一个问题，便于上级机关有针对性地批复。一文多事会导致批复难以落实。',
    pitfall: '「报告」可以综合汇报多项工作，「请示」必须一文一事，两者要求不同。',
    keyPoint: '请示的行文规则：一文一事。',
    tags: ['行文规则', '请示']
  },
  {
    id: 'GK-ECON-J1',
    subject: '公共基础知识',
    chapter: '经济管理',
    type: 'judge',
    level: 2,
    stem: '通货膨胀是指物价总水平在一段时间内持续、普遍地上涨。',
    options: [
      { key: 'A', text: '正确' },
      { key: 'B', text: '错误' }
    ],
    answer: ['A'],
    explain: '通货膨胀强调的是「总水平」「持续」「普遍」三个特征，单一商品涨价或短期价格波动不构成通货膨胀。',
    pitfall: '缺少「普遍」二字不成立——个别商品涨价属于相对价格变化。',
    keyPoint: '通货膨胀的定义要素。',
    tags: ['宏观经济']
  },
  {
    id: 'IT-SEC-J1',
    subject: '专业知识',
    chapter: '信息安全',
    type: 'judge',
    level: 1,
    stem: '只要安装了杀毒软件，信息系统就不会受到任何攻击。',
    options: [
      { key: 'A', text: '正确' },
      { key: 'B', text: '错误' }
    ],
    answer: ['B'],
    explain: '杀毒软件主要基于特征库查杀已知恶意代码，对零日漏洞、社会工程学攻击、内部威胁等无能为力，需要纵深防御体系配合。',
    pitfall: '题干出现「只要…就不会…任何…」这类绝对化表述，基本都是错误项。',
    keyPoint: '安全是体系工程，不存在单一银弹。',
    tags: ['安全防护']
  },

  /* ---------------- 不定项选择 ---------------- */
  {
    id: 'GK-LAW-U1',
    subject: '公共基础知识',
    chapter: '法律常识',
    type: 'uncertain',
    level: 3,
    stem: '下列属于我国宪法规定的公民基本权利的有：',
    options: [
      { key: 'A', text: '平等权' },
      { key: 'B', text: '宗教信仰自由' },
      { key: 'C', text: '依法纳税' },
      { key: 'D', text: '受教育权' }
    ],
    answer: ['A', 'B', 'D'],
    explain: '平等权、宗教信仰自由、受教育权均属于公民基本权利；依法纳税是宪法规定的公民基本义务，不是权利。',
    pitfall: '不定项题要逐项判断，混合了「义务」的选项最易被误选。',
    keyPoint: '公民基本权利与义务的区分。',
    tags: ['宪法', '公民权利']
  },
  {
    id: 'GK-ECON-U1',
    subject: '公共基础知识',
    chapter: '经济管理',
    type: 'uncertain',
    level: 3,
    stem: '下列属于财政政策工具的有：',
    options: [
      { key: 'A', text: '税收' },
      { key: 'B', text: '政府购买' },
      { key: 'C', text: '存款准备金率' },
      { key: 'D', text: '转移支付' }
    ],
    answer: ['A', 'B', 'D'],
    explain: '税收、政府购买、转移支付都通过收支影响总需求，属于财政政策工具；存款准备金率由中央银行操作，属于货币政策工具。',
    pitfall: '财政看「收支」，货币看「利率、准备金、公开市场操作」。',
    keyPoint: '财政政策与货币政策工具的分野。',
    tags: ['宏观调控']
  },
  {
    id: 'IT-SEC-U1',
    subject: '专业知识',
    chapter: '信息安全',
    type: 'uncertain',
    level: 2,
    stem: '下列做法有助于防范钓鱼邮件的有：',
    options: [
      { key: 'A', text: '核对发件人邮箱域名是否为官方域名' },
      { key: 'B', text: '不点击邮件中的可疑短链接' },
      { key: 'C', text: '打开附件并启用宏以查看内容' },
      { key: 'D', text: '在网关侧开启附件沙箱检测' }
    ],
    answer: ['A', 'B', 'D'],
    explain: '核对域名、避免点击可疑链接、网关侧沙箱检测都是有效防护措施；随意启用 Office 宏正是钓鱼邮件的典型投递方式。',
    pitfall: '「启用宏查看内容」是攻击链环节而非防护措施。',
    keyPoint: '钓鱼邮件防护要点。',
    tags: ['安全防护', '邮件安全']
  },

  /* ---------------- 填空题 ---------------- */
  {
    id: 'GK-LAW-F1',
    subject: '公共基础知识',
    chapter: '法律常识',
    type: 'fill',
    level: 2,
    stem: '《中华人民共和国民法典》自 ___ 年 1 月 1 日起施行。',
    answer: ['2021'],
    explain: '《民法典》于 2020 年 5 月 28 日表决通过，自 2021 年 1 月 1 日起施行，是我国第一部以「法典」命名的法律。',
    pitfall: '通过年份（2020）与施行年份（2021）不同，题目问的是「施行」。',
    keyPoint: '民法典施行时间：2021.1.1。',
    tags: ['民法典']
  },
  {
    id: 'GK-WRIT-F1',
    subject: '公共基础知识',
    chapter: '公文写作',
    type: 'fill',
    level: 2,
    stem: '公文标题一般由发文机关名称、___ 和文种三个要素构成。',
    answer: [['事由', '事由要素']],
    explain: '公文标题三要素为「发文机关名称 + 事由 + 文种」，如《国务院关于印发…的通知》。',
    pitfall: '中间一项是「事由」不是「主送机关」。',
    keyPoint: '公文标题三要素。',
    tags: ['公文格式']
  },
  {
    id: 'IT-SEC-F1',
    subject: '专业知识',
    chapter: '信息安全',
    type: 'fill',
    level: 2,
    stem: '在 TCP/IP 参考模型中，HTTP 协议工作在 ___ 层。',
    answer: [['应用层', '应用']],
    explain: 'TCP/IP 模型自上而下为应用层、传输层、网际层、网络接口层。HTTP、FTP、SMTP 等均属于应用层协议。',
    pitfall: '不要与 OSI 七层模型混淆——OSI 中 HTTP 同样是应用层，但 TCP/IP 只有四层。',
    keyPoint: 'TCP/IP 四层模型与典型协议归属。',
    tags: ['网络基础']
  },

  /* ---------------- 排序题 ---------------- */
  {
    id: 'GK-WRIT-S1',
    subject: '公共基础知识',
    chapter: '公文写作',
    type: 'sort',
    level: 2,
    stem: '请将下列发文办理环节按正确先后顺序排列：',
    options: [
      { key: 'A', text: '签发' },
      { key: 'B', text: '拟稿' },
      { key: 'C', text: '印发' },
      { key: 'D', text: '审核' }
    ],
    answer: ['B', 'D', 'A', 'C'],
    explain: '发文办理流程为：拟稿（承办部门起草）→ 审核（办公厅/室把关）→ 签发（机关负责人签署）→ 印发（编号、缮印、分发）。',
    pitfall: '「签发」在「审核」之后、「印发」之前，顺序颠倒是最常见错误。',
    keyPoint: '发文办理：拟稿—审核—签发—印发。',
    tags: ['公文处理']
  },
  {
    id: 'IT-SEC-S1',
    subject: '专业知识',
    chapter: '信息安全',
    type: 'sort',
    level: 3,
    stem: '请将下列信息安全事件处置阶段按合理先后排列：',
    options: [
      { key: 'A', text: '遏制（Containment）' },
      { key: 'B', text: '准备（Preparation）' },
      { key: 'C', text: '恢复（Recovery）' },
      { key: 'D', text: '检测与分析（Detection）' }
    ],
    answer: ['B', 'D', 'A', 'C'],
    explain: '标准处置顺序：准备（预案、演练）→ 检测与分析（发现与研判）→ 遏制（限制影响范围）→ 恢复（业务回归）→ 事后总结。',
    pitfall: '必须先「遏制」再「恢复」，未阻断攻击源就恢复会导致反复失陷。',
    keyPoint: '事件处置：准备—检测—遏制—恢复。',
    tags: ['应急响应']
  }
]

function getAllQuestions() {
  return QUESTIONS.slice()
}

function findQuestion(id) {
  if (!id) return null
  return QUESTIONS.filter((q) => q.id === id)[0] || null
}

function getSubjects() {
  const map = {}
  QUESTIONS.forEach((q) => {
    map[q.subject] = (map[q.subject] || 0) + 1
  })
  return Object.keys(map).map((name) => ({ name: name, count: map[name] }))
}

function getChapters(subject) {
  const map = {}
  QUESTIONS.forEach((q) => {
    if (subject && q.subject !== subject) return
    map[q.chapter] = (map[q.chapter] || 0) + 1
  })
  return Object.keys(map)
}

function getQuestionsByIds(ids) {
  const list = Array.isArray(ids) ? ids : []
  return list.map((id) => findQuestion(id)).filter(Boolean)
}

function filterQuestions(option) {
  const opt = option || {}
  let list = QUESTIONS.filter((q) => {
    if (opt.subject && q.subject !== opt.subject) return false
    if (opt.chapter && q.chapter !== opt.chapter) return false
    if (opt.type && q.type !== opt.type) return false
    return true
  })
  if (opt.ids && opt.ids.length) {
    const set = {}
    opt.ids.forEach((id) => {
      set[id] = true
    })
    list = list.filter((q) => set[q.id])
  }
  return list
}

function shuffle(list) {
  const arr = list.slice()
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = arr[i]
    arr[i] = arr[j]
    arr[j] = t
  }
  return arr
}

const TYPE_MAP = {
  single: '单选题',
  multiple: '多选题',
  judge: '判断题',
  uncertain: '不定项选择',
  fill: '填空题',
  sort: '排序题'
}

function typeName(type) {
  return TYPE_MAP[type] || '单选题'
}

/** 各题型作答提示（展示在答题页底部） */
function typeTip(type) {
  return (
    {
      single: '单选题：选择一个最符合题意的选项',
      multiple: '多选题：可同时选择多个选项',
      judge: '判断题：选择「正确」或「错误」',
      uncertain: '不定项选择：正确选项 1 个或多个，需全部选对才得分',
      fill: '填空题：按空位顺序填写，不区分大小写与多余空格',
      sort: '排序题：点击选项依次加入，可上下调整，需排满所有项'
    }[type] || ''
  )
}

/** 是否可同时选多项 */
function isMultiSelect(type) {
  return type === 'multiple' || type === 'uncertain'
}

/** 正确答案的纯文本展示：填空取首个同义答案，排序用箭头连接 */
function answerPlain(question) {
  if (!question) return ''
  const answer = Array.isArray(question.answer) ? question.answer : []
  if (question.type === 'fill') {
    return answer.map((a) => (Array.isArray(a) ? a[0] : a)).join('、')
  }
  if (question.type === 'sort') {
    return answer.join(' → ')
  }
  if (question.type === 'judge') {
    // 判断题只显示 key 没有意义，回显「正确 / 错误」
    const opts = question.options || []
    return answer
      .map((k) => {
        const o = opts.filter((x) => x.key === k)[0]
        return o ? o.text : k
      })
      .join('')
  }
  return answer.join('')
}

/** 文本归一化：去掉全部空白、统一小写，用于填空判分 */
function normalizeText(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/\s+/g, '')
    .toLowerCase()
}

/**
 * 统一判分入口：practice 与 question-card 共用，避免两处判定逻辑不一致
 * @param {String} type 题型
 * @param {Array} selected 用户作答。选择类为 key 数组；填空为字符串数组；排序为有序 key 数组
 * @param {Array} answer 正确答案
 * @returns {Boolean}
 */
function judge(type, selected, answer) {
  const sel = Array.isArray(selected) ? selected.slice() : []
  const ans = Array.isArray(answer) ? answer.slice() : []

  // 填空：按空位顺序逐空比对，支持同义答案数组
  if (type === 'fill') {
    if (sel.length !== ans.length) return false
    return ans.every((expect, i) => {
      const list = Array.isArray(expect) ? expect : [expect]
      const got = normalizeText(sel[i])
      if (!got) return false
      return list.some((e) => normalizeText(e) === got)
    })
  }

  // 排序：顺序全等
  if (type === 'sort') {
    if (sel.length !== ans.length) return false
    return ans.every((k, i) => String(k) === String(sel[i]))
  }

  // 单选 / 多选 / 判断 / 不定项：集合比较
  return sel.length === ans.length && ans.every((k) => sel.indexOf(k) > -1)
}

module.exports = {
  QUESTIONS,
  getAllQuestions,
  findQuestion,
  getSubjects,
  getChapters,
  getQuestionsByIds,
  filterQuestions,
  shuffle,
  typeName,
  typeTip,
  answerPlain,
  isMultiSelect,
  normalizeText,
  judge,
  TYPE_MAP
}
