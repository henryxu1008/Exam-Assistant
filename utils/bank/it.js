// 题库分片：专业知识（由 questions.js 拆分，科目定义见 manifest.js）
module.exports = [
  {
    "id": "IT-OS-01",
    "subject": "专业知识",
    "chapter": "操作系统",
    "type": "single",
    "level": 2,
    "stem": "关于进程与线程，下列说法正确的是：",
    "options": [
      {
        "key": "A",
        "text": "进程是 CPU 调度的基本单位"
      },
      {
        "key": "B",
        "text": "线程拥有完全独立的地址空间"
      },
      {
        "key": "C",
        "text": "一个进程中可以包含多个线程"
      },
      {
        "key": "D",
        "text": "线程之间不能共享任何资源"
      }
    ],
    "answer": [
      "C"
    ],
    "explain": "线程是 CPU 调度的基本单位，进程是资源分配的基本单位；同一进程内的多个线程共享进程的地址空间和资源，各自拥有独立的栈与寄存器上下文。",
    "pitfall": "「调度」对线程，「分配资源」对进程，两句话务必配套记忆。",
    "keyPoint": "进程与线程的关系与区别。",
    "tags": [
      "进程管理"
    ]
  },
  {
    "id": "IT-OS-02",
    "subject": "专业知识",
    "chapter": "操作系统",
    "type": "single",
    "level": 2,
    "stem": "下列各项中，不属于产生死锁必要条件的是：",
    "options": [
      {
        "key": "A",
        "text": "互斥条件"
      },
      {
        "key": "B",
        "text": "占有且等待条件"
      },
      {
        "key": "C",
        "text": "资源可被抢占条件"
      },
      {
        "key": "D",
        "text": "循环等待条件"
      }
    ],
    "answer": [
      "C"
    ],
    "explain": "死锁的四个必要条件是：互斥、占有且等待、不可抢占、循环等待。资源可被抢占反而有助于解除死锁，因此不是必要条件。",
    "pitfall": "必要条件是「不可抢占」而非「可抢占」，注意否定词的差异。",
    "keyPoint": "死锁四必要条件。",
    "tags": [
      "死锁"
    ]
  },
  {
    "id": "IT-OS-03",
    "subject": "专业知识",
    "chapter": "操作系统",
    "type": "single",
    "level": 1,
    "stem": "引入虚拟内存技术的主要目的是：",
    "options": [
      {
        "key": "A",
        "text": "提高 CPU 主频"
      },
      {
        "key": "B",
        "text": "在逻辑上扩充内存，使更大的程序得以运行"
      },
      {
        "key": "C",
        "text": "替代高速缓存 Cache"
      },
      {
        "key": "D",
        "text": "加快磁盘的物理读写速度"
      }
    ],
    "answer": [
      "B"
    ],
    "explain": "虚拟内存把磁盘作为内存的延伸，让进程在远大于实际物理内存的逻辑地址空间中运行，由操作系统负责页面调入调出。",
    "pitfall": "虚拟内存并不提高任何硬件速度，反而可能因缺页中断带来额外开销。",
    "keyPoint": "虚拟内存的作用与实现原理。",
    "tags": [
      "内存管理"
    ]
  },
  {
    "id": "IT-NET-01",
    "subject": "专业知识",
    "chapter": "网络基础",
    "type": "single",
    "level": 2,
    "stem": "在 OSI 参考模型中，负责路由选择与 IP 寻址的是：",
    "options": [
      {
        "key": "A",
        "text": "数据链路层"
      },
      {
        "key": "B",
        "text": "网络层"
      },
      {
        "key": "C",
        "text": "传输层"
      },
      {
        "key": "D",
        "text": "会话层"
      }
    ],
    "answer": [
      "B"
    ],
    "explain": "网络层负责逻辑寻址（IP）与路由选择；数据链路层负责相邻节点的帧传输与 MAC 寻址；传输层负责端到端可靠传输（TCP/UDP）。",
    "pitfall": "「相邻节点」→链路层，「端到端」→传输层，「跨网络选路」→网络层。",
    "keyPoint": "OSI 七层模型各层职责。",
    "tags": [
      "网络模型"
    ]
  },
  {
    "id": "IT-NET-02",
    "subject": "专业知识",
    "chapter": "网络基础",
    "type": "single",
    "level": 2,
    "stem": "关于 TCP 与 UDP，下列说法正确的是：",
    "options": [
      {
        "key": "A",
        "text": "TCP 不保证数据的可靠到达"
      },
      {
        "key": "B",
        "text": "UDP 是面向连接的协议"
      },
      {
        "key": "C",
        "text": "TCP 提供流量控制与拥塞控制机制"
      },
      {
        "key": "D",
        "text": "UDP 通过三次握手建立连接"
      }
    ],
    "answer": [
      "C"
    ],
    "explain": "TCP 面向连接、可靠、有序，并提供流量控制与拥塞控制；UDP 无连接、尽最大努力交付，开销小但不保证可靠。",
    "pitfall": "把可靠性放在第一位选 TCP，把实时性与低开销放在第一位选 UDP。",
    "keyPoint": "TCP 与 UDP 的特性对比。",
    "tags": [
      "传输层协议"
    ]
  },
  {
    "id": "IT-NET-03",
    "subject": "专业知识",
    "chapter": "网络基础",
    "type": "single",
    "level": 1,
    "stem": "用于将域名转换为 IP 地址的协议是：",
    "options": [
      {
        "key": "A",
        "text": "HTTP"
      },
      {
        "key": "B",
        "text": "DNS"
      },
      {
        "key": "C",
        "text": "FTP"
      },
      {
        "key": "D",
        "text": "SMTP"
      }
    ],
    "answer": [
      "B"
    ],
    "explain": "DNS（域名系统）完成域名到 IP 地址的解析；HTTP 用于网页传输，FTP 用于文件传输，SMTP 用于邮件发送。",
    "pitfall": "记住各协议的功能定位即可秒杀此类识记题。",
    "keyPoint": "常见应用层协议的功能。",
    "tags": [
      "应用层协议"
    ]
  },
  {
    "id": "IT-DB-01",
    "subject": "专业知识",
    "chapter": "数据库",
    "type": "single",
    "level": 1,
    "stem": "在关系数据库中，能够唯一标识一条记录并保证不重复的字段称为：",
    "options": [
      {
        "key": "A",
        "text": "外键"
      },
      {
        "key": "B",
        "text": "主键"
      },
      {
        "key": "C",
        "text": "索引"
      },
      {
        "key": "D",
        "text": "视图"
      }
    ],
    "answer": [
      "B"
    ],
    "explain": "主键唯一标识表中的每一条记录且不能重复、不能为空；外键用于建立表间联系，索引用于提升查询效率，视图是虚拟表。",
    "pitfall": "索引用于「提速」，主键用于「唯一标识」，不要混用两者的职责。",
    "keyPoint": "关系数据库完整性约束。",
    "tags": [
      "基本概念"
    ]
  },
  {
    "id": "IT-DB-02",
    "subject": "专业知识",
    "chapter": "数据库",
    "type": "single",
    "level": 2,
    "stem": "SQL 语句 SELECT * FROM student WHERE age > 20 ORDER BY score DESC 表示：",
    "options": [
      {
        "key": "A",
        "text": "查询年龄大于 20 的学生，并按成绩升序排列"
      },
      {
        "key": "B",
        "text": "查询年龄大于 20 的学生，并按成绩降序排列"
      },
      {
        "key": "C",
        "text": "查询成绩最高的学生信息"
      },
      {
        "key": "D",
        "text": "先按年龄排序，再筛选 20 岁以上学生"
      }
    ],
    "answer": [
      "B"
    ],
    "explain": "WHERE 用于筛选，ORDER BY 指定排序字段，DESC 表示降序（ASC 为升序）。",
    "pitfall": "DESC = 降序（从大到小），ASC = 升序；SQL 中先 WHERE 筛选再 ORDER BY 排序。",
    "keyPoint": "SELECT 语句的子句执行顺序。",
    "tags": [
      "SQL"
    ]
  },
  {
    "id": "IT-DB-03",
    "subject": "专业知识",
    "chapter": "数据库",
    "type": "single",
    "level": 2,
    "stem": "事务的 ACID 特性中，字母 C 代表的是：",
    "options": [
      {
        "key": "A",
        "text": "原子性"
      },
      {
        "key": "B",
        "text": "一致性"
      },
      {
        "key": "C",
        "text": "隔离性"
      },
      {
        "key": "D",
        "text": "持久性"
      }
    ],
    "answer": [
      "B"
    ],
    "explain": "ACID 分别指 Atomicity（原子性）、Consistency（一致性）、Isolation（隔离性）、Durability（持久性）。",
    "pitfall": "注意英文首字母对应关系：A 原子、C 一致、I 隔离、D 持久。",
    "keyPoint": "事务的四大特性。",
    "tags": [
      "事务"
    ]
  },
  {
    "id": "IT-SEC-01",
    "subject": "专业知识",
    "chapter": "信息安全",
    "type": "single",
    "level": 2,
    "stem": "下列属于对称加密算法的是：",
    "options": [
      {
        "key": "A",
        "text": "RSA"
      },
      {
        "key": "B",
        "text": "AES"
      },
      {
        "key": "C",
        "text": "ECC"
      },
      {
        "key": "D",
        "text": "DSA"
      }
    ],
    "answer": [
      "B"
    ],
    "explain": "对称加密的加解密使用同一密钥，典型算法有 AES、DES、3DES；RSA、ECC、DSA 都属于非对称加密或签名算法。",
    "pitfall": "对称＝同一把钥匙，实际業務中常用于大量数据的加密。",
    "keyPoint": "对称加密与非对称加密的区别。",
    "tags": [
      "密码学基础"
    ]
  },
  {
    "id": "IT-SEC-02",
    "subject": "专业知识",
    "chapter": "信息安全",
    "type": "single",
    "level": 2,
    "stem": "关于哈希算法（如 MD5、SHA 系列），下列说法错误的是：",
    "options": [
      {
        "key": "A",
        "text": "具有单向性，通常难以由摘要还原原文"
      },
      {
        "key": "B",
        "text": "无论输入多长，输出长度固定"
      },
      {
        "key": "C",
        "text": "可以使用相同密钥把摘要还原为原文"
      },
      {
        "key": "D",
        "text": "理想情况下应具有较强的抗碰撞能力"
      }
    ],
    "answer": [
      "C"
    ],
    "explain": "哈希是单向不可逆的压缩映射，不存在「密钥」概念，也无法从摘要解密出原文；它常用于完整性校验与口令摘要存储。",
    "pitfall": "加密可以解密（对称/非对称），哈希只能校验不能还原。",
    "keyPoint": "哈希算法的三大特征。",
    "tags": [
      "密码学基础"
    ]
  },
  {
    "id": "IT-SEC-03",
    "subject": "专业知识",
    "chapter": "信息安全",
    "type": "single",
    "level": 1,
    "stem": "下列措施中，对防范弱口令攻击最有效的是：",
    "options": [
      {
        "key": "A",
        "text": "定期更换显示器"
      },
      {
        "key": "B",
        "text": "使用复杂度足够的口令并开启双因素认证"
      },
      {
        "key": "C",
        "text": "关闭系统防火墙以减少暴露面"
      },
      {
        "key": "D",
        "text": "多人共享同一个账号便于管理"
      }
    ],
    "answer": [
      "B"
    ],
    "explain": "提高口令复杂度并启用双因素认证（如短信/动态口令/硬件密钥）可显著降低口令被爆破或撞库的风险。",
    "pitfall": "共享账号会破坏可追溯性，是账号管理的大忌。",
    "keyPoint": "身份认证加固措施。",
    "tags": [
      "安全防护"
    ]
  },
  {
    "id": "IT-SEC-04",
    "subject": "专业知识",
    "chapter": "信息安全",
    "type": "multiple",
    "level": 2,
    "stem": "下列属于人工智能典型应用的有：",
    "options": [
      {
        "key": "A",
        "text": "语音识别"
      },
      {
        "key": "B",
        "text": "机器翻译"
      },
      {
        "key": "C",
        "text": "推荐系统"
      },
      {
        "key": "D",
        "text": "数据定时备份"
      }
    ],
    "answer": [
      "A",
      "B",
      "C"
    ],
    "explain": "语音识别、机器翻译、推荐系统均依赖机器学习模型完成感知或决策；数据定时备份属于运维容灾手段，与人工智能无关。",
    "pitfall": "判断标准是系统是否具备「从数据中学习并预测」的能力。",
    "keyPoint": "人工智能典型应用场景。",
    "tags": [
      "前沿技术"
    ]
  },
  {
    "id": "IT-SEC-J1",
    "subject": "专业知识",
    "chapter": "信息安全",
    "type": "judge",
    "level": 1,
    "stem": "只要安装了杀毒软件，信息系统就不会受到任何攻击。",
    "options": [
      {
        "key": "A",
        "text": "正确"
      },
      {
        "key": "B",
        "text": "错误"
      }
    ],
    "answer": [
      "B"
    ],
    "explain": "杀毒软件主要基于特征库查杀已知恶意代码，对零日漏洞、社会工程学攻击、内部威胁等无能为力，需要纵深防御体系配合。",
    "pitfall": "题干出现「只要…就不会…任何…」这类绝对化表述，基本都是错误项。",
    "keyPoint": "安全是体系工程，不存在单一银弹。",
    "tags": [
      "安全防护"
    ]
  },
  {
    "id": "IT-SEC-U1",
    "subject": "专业知识",
    "chapter": "信息安全",
    "type": "uncertain",
    "level": 2,
    "stem": "下列做法有助于防范钓鱼邮件的有：",
    "options": [
      {
        "key": "A",
        "text": "核对发件人邮箱域名是否为官方域名"
      },
      {
        "key": "B",
        "text": "不点击邮件中的可疑短链接"
      },
      {
        "key": "C",
        "text": "打开附件并启用宏以查看内容"
      },
      {
        "key": "D",
        "text": "在网关侧开启附件沙箱检测"
      }
    ],
    "answer": [
      "A",
      "B",
      "D"
    ],
    "explain": "核对域名、避免点击可疑链接、网关侧沙箱检测都是有效防护措施；随意启用 Office 宏正是钓鱼邮件的典型投递方式。",
    "pitfall": "「启用宏查看内容」是攻击链环节而非防护措施。",
    "keyPoint": "钓鱼邮件防护要点。",
    "tags": [
      "安全防护",
      "邮件安全"
    ]
  },
  {
    "id": "IT-SEC-F1",
    "subject": "专业知识",
    "chapter": "信息安全",
    "type": "fill",
    "level": 2,
    "stem": "在 TCP/IP 参考模型中，HTTP 协议工作在 ___ 层。",
    "answer": [
      [
        "应用层",
        "应用"
      ]
    ],
    "explain": "TCP/IP 模型自上而下为应用层、传输层、网际层、网络接口层。HTTP、FTP、SMTP 等均属于应用层协议。",
    "pitfall": "不要与 OSI 七层模型混淆——OSI 中 HTTP 同样是应用层，但 TCP/IP 只有四层。",
    "keyPoint": "TCP/IP 四层模型与典型协议归属。",
    "tags": [
      "网络基础"
    ]
  },
  {
    "id": "IT-SEC-S1",
    "subject": "专业知识",
    "chapter": "信息安全",
    "type": "sort",
    "level": 3,
    "stem": "请将下列信息安全事件处置阶段按合理先后排列：",
    "options": [
      {
        "key": "A",
        "text": "遏制（Containment）"
      },
      {
        "key": "B",
        "text": "准备（Preparation）"
      },
      {
        "key": "C",
        "text": "恢复（Recovery）"
      },
      {
        "key": "D",
        "text": "检测与分析（Detection）"
      }
    ],
    "answer": [
      "B",
      "D",
      "A",
      "C"
    ],
    "explain": "标准处置顺序：准备（预案、演练）→ 检测与分析（发现与研判）→ 遏制（限制影响范围）→ 恢复（业务回归）→ 事后总结。",
    "pitfall": "必须先「遏制」再「恢复」，未阻断攻击源就恢复会导致反复失陷。",
    "keyPoint": "事件处置：准备—检测—遏制—恢复。",
    "tags": [
      "应急响应"
    ]
  }
]
