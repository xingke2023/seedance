'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import { ProjectSubject } from '@/components/video-editor/types';
import styles from './page.module.css';

interface Video {
  id: string;
  name: string;
  script: string | null;
  status: string;
  ratio: string;
  shot_count: number;
  merged_video_url: string | null;
  created_at: string;
  updated_at: string;
}

interface Project {
  id: string;
  name: string;
  description: string | null;
}

interface AssetGroup {
  Id: string;
  Name: string | null;
  GroupType: 'AIGC' | 'LivenessFace';
}

interface Asset {
  Id: string;
  Name: string | null;
  AssetType: string;
  Status: string;
  PreviewUrl?: string;
  URL?: string;
}

type AddMode = 'manual' | 'real' | 'virtual' | 'avatar' | 'ai';

const STATUS_MAP: Record<string, { label: string; color: string; bg: string }> = {
  draft:      { label: '草稿', color: '#6b7280', bg: '#f3f4f6' },
  generating: { label: '生成中', color: '#1d4ed8', bg: '#dbeafe' },
  done:       { label: '已完成', color: '#166534', bg: '#dcfce7' },
};

const AI_CREATE_PROMPTS: Record<string, string[]> = {
  '写实人物': [
    '年轻女性，长发披肩，职业装，自信微笑',
    '中年男性，短发，休闲风，温和表情',
    '成熟男性，西装革履，商务精英气质',
    '商务女性，短发干练，眼镜，笔记本电脑',
    '阳光大男孩，白T恤牛仔裤，灿烂笑容',
    '韩系甜美女生，空气刘海，针织衫，奶茶色',
    '运动少年，短袖T恤，阳光帅气',
    '旗袍女子，民国风，波浪短发，手持折扇',
    '老年智者，白胡子，长袍，手持书卷',
    '少女，学生制服，双马尾，活泼可爱',
    '温柔妈妈，围裙，厨房背景，慈祥笑容',
    '健身教练，紧身运动衣，肌肉线条，健身房',
    '文艺青年，圆框眼镜，毛衣，咖啡馆背景',
    '护士小姐姐，白色护士服，温柔微笑，医院走廊',
    '摄影师，相机挂脖，休闲外套，街头背景',
    '厨师，白色厨师帽，双手叉腰，自信表情',
    '教师，黑框眼镜，手持粉笔，黑板前',
    '消防员，红色消防服，头盔，英勇形象',
    '飞行员，制服墨镜，机场跑道背景',
    '模特，高挑身材，时尚穿搭，T台背景',
    '医生，白大褂，听诊器，专业形象',
    '律师，深色西装，文件夹，法庭背景',
    '画家，贝雷帽，沾满颜料的围裙，画室',
    '音乐家，小提琴，燕尾服，舞台灯光',
    '程序员，帽衫，笔记本电脑，代码屏幕',
    '舞蹈演员，芭蕾舞裙，优雅姿态，练功房',
    '记者，话筒，干练短发，新闻现场',
    '花店老板，碎花围裙，手捧鲜花，温馨花店',
    '建筑师，安全帽，图纸，工地背景',
    '潜水员，潜水服，面镜，海底珊瑚',
    '调酒师，马甲白衬衫，调酒壶，酒吧灯光',
    '瑜伽教练，运动背心，莲花坐姿，户外草地',
    '甜点师，粉色围裙，裱花袋，蛋糕台',
    '书法家，中式长衫，毛笔，宣纸',
    '快递小哥，蓝色工服，包裹，电动车旁',
    '主播女孩，环形灯，麦克风，直播间',
    '登山者，冲锋衣，登山杖，雪山背景',
    '科学家，实验室白大褂，试管，显微镜',
    '街头艺人，吉他，牛仔帽，广场夕阳',
    '外卖骑手，黄色头盔，保温箱，城市街道',
  ],
  '动漫二次元': [
    '日系动漫少女，大眼睛，粉色短发，水手服',
    '二次元男生，银色刺猬头，学院风外套',
    '魔法少女，星星法杖，紫色长裙，闪亮翅膀',
    '哥特风少女，黑色蕾丝裙，蔷薇花，暗色调',
    '可爱猫娘，猫耳朵，尾巴，女仆装',
    '忍者少年，面具，暗色忍者服，手里剑',
    '精灵公主，尖耳朵，花环头饰，森林绿裙',
    '热血少年，红色披风，燃烧拳头，战斗姿态',
    '治愈系少女，淡绿长发，白裙，花田背景',
    '机甲驾驶员，紧身战斗服，全息面罩',
    '吸血鬼贵族，红眼，黑色斗篷，月光城堡',
    '天使少女，白色翅膀，光环，云端背景',
    '恶魔少年，黑色角，尾巴，暗红瞳孔',
    '偶像歌手，舞台装，荧光棒，演唱会',
    '剑士少女，双马尾，日式校服，背负太刀',
    '狐仙女子，狐耳九尾，和服，樱花飘落',
    '龙族少年，龙角，鳞片纹身，火焰背景',
    '人鱼公主，蓝色鱼尾，贝壳发饰，海底宫殿',
    '赏金猎人，皮革长靴，双枪，荒野夕阳',
    '学生会长，眼镜，严肃表情，手持文件',
    '魔王大人，王冠，暗紫长袍，王座',
    '巫女少女，红白巫女服，御札，神社鸟居',
    '死神使者，黑色镰刀，连帽斗篷，灵魂火',
    '时间旅行者，怀表，维多利亚风大衣，齿轮',
    '冰系魔法师，冰蓝色长发，雪花纹理法杖',
    '元素精灵，透明翅膀，水晶球，七彩光芒',
    '暗杀者，黑衣，匕首，烟雾缭绕屋顶',
    '圣骑士，金色铠甲，光之剑，教堂背景',
    '召唤师，魔法阵，灵兽伙伴，星空',
    '电竞选手，游戏外设，战队服，比赛现场',
    '异世界勇者，新手装备，冒险背包，村庄出发',
    '妖刀少女，和风，裂纹刀刃，血月背景',
    '音乐精灵，竖琴，音符光粒，梦幻背景',
    '炼金术士，护目镜，药剂瓶，实验室',
    '兽耳少年，狼耳，白发，部落装扮',
    '花仙子，花瓣裙，蝴蝶环绕，春日花园',
    '黑客少女，霓虹眼镜，数据流背景',
    '骑士团长，重甲，盾牌，城堡大厅',
    '占星师，星图，水晶球，天文台',
    '双子姐妹，一黑一白，镜像姿态',
  ],
  '卡通Q版': [
    'Q版小女孩，大头，腮红，背书包',
    '卡通熊猫角色，圆滚滚，竹叶帽子',
    '像素风小人，复古游戏风格，冒险者装扮',
    '机器人管家，圆脸，蝴蝶结，银色外壳',
    '卡通小恐龙，绿色，大眼，背小书包',
    'Q版古装小公主，丸子头，粉色汉服',
    '圆滚滚小柴犬，穿围裙，厨师帽',
    'Q版宇航员，大头盔，星星贴纸，可爱比心',
    '卡通独角兽，彩虹鬃毛，闪亮大眼',
    '迷你小精灵，蘑菇帽子，坐在花朵上',
    'Q版超级英雄，迷你斗篷，胖嘟嘟拳头',
    '卡通小鲸鱼，喷水，蓝白色，海洋背景',
    'Q版小厨师，高帽子，拿着大勺子，围裙',
    '毛茸茸小猫咪，蝴蝶结铃铛，毛线球',
    'Q版小海盗，三角帽，眼罩，宝藏地图',
    '卡通仙人掌，戴墨镜，花盆里跳舞',
    'Q版小魔女，尖帽子，骑扫帚，黑猫',
    '橡皮泥风格小人，彩色，手工质感',
    '卡通小蜜蜂，条纹衣服，翅膀，蜂蜜罐',
    'Q版消防员，大头小身体，水管，消防车',
    '棉花糖小兔子，粉白色，蓬松耳朵',
    'Q版小忍者，大眼睛透过面罩，手里剑',
    '卡通小狮子，大脑袋鬃毛，草原背景',
    'Q版美人鱼，圆脸，贝壳发夹，泡泡',
    '乐高风格小人，方块头，简约表情',
    '卡通小章鱼，粉色，戴厨师帽，章鱼烧',
    'Q版小天使，肉嘟嘟，迷你翅膀，光圈歪',
    '卡通小企鹅，围巾，滑冰鞋，冰面',
    'Q版小医生，大针管，白大褂，红十字',
    '泡泡玛特风格盲盒娃娃，大头，潮玩装扮',
    '卡通小考拉，抱树枝，桉树叶帽子',
    'Q版小侦探，放大镜，猎鹿帽，烟斗',
    '卡通小火箭，拟人化，笑脸，星空发射',
    'Q版国王，大王冠，小身体，红色披风',
    '果冻质感小熊，透明感，糖果色',
    'Q版小邮差，大信封，蓝色帽子，自行车',
    '卡通小蘑菇精灵，红白点，短腿奔跑',
    'Q版双胞胎，一个天使一个恶魔',
    '卡通小刺猬，背果子，落叶森林',
    'Q版小DJ，大耳机，打碟台，音符飞溅',
  ],
  '国风古韵': [
    '古风女子，汉服，发簪，温婉古典',
    '国风武侠男子，持剑，飘逸长发，白衣',
    '水墨风仙鹤，中国画风格，祥云环绕',
    '敦煌飞天仙女，飘带，莲花，金色光芒',
    '书生公子，折扇，青衫，竹林背景',
    '将军铠甲，红色披风，持戟，战场背景',
    '古风少女，琵琶，桃花树下，月光',
    '道士形象，八卦道袍，拂尘，仙气飘飘',
    '古代小商贩，挑担，笑容满面，集市背景',
    '花旦脸谱，京剧装扮，凤冠霞帔',
    '仙侠御剑飞行，云海之上，剑光闪烁',
    '茶道大师，素色长衫，紫砂壶，茶室',
    '山水画中渔翁，竹笠蓑衣，江面小舟',
    '苗族少女，银饰头冠，刺绣服饰，梯田',
    '太极拳师，白色练功服，晨光公园',
    '古琴女子，素手拨弦，松下清泉，高山',
    '镖局镖师，腰刀，马匹，古道驿站',
    '绣娘，绣花绷子，丝线，窗边阳光',
    '说书先生，折扇醒木，茶馆，观众围坐',
    '蒙古族骑手，弓箭，鹰，草原奔马',
    '唐代仕女，高髻，广袖襦裙，团扇',
    '侠客少年，竹笛，青衣，客栈屋顶明月',
    '戏曲武生，翎子，靠旗，舞台亮相',
    '藏族姑娘，藏袍，绿松石饰品，雪山',
    '皮影戏人物，彩色剪影，灯光幕布',
    '古代药师，背药箱，草药，深山采药',
    '年画娃娃，胖墩墩，抱鲤鱼，红色喜庆',
    '笔墨仙人，泼墨成画，仙鹤白鹿相随',
    '傣族少女，孔雀舞姿态，金色塔尖背景',
    '铁匠师傅，打铁花，火星飞溅，作坊',
    '白蛇传白素贞，白衣飘飘，断桥残雪',
    '孙悟空形象，金箍棒，筋斗云，桃花',
    '青花瓷风格仕女，蓝白色调，瓷器纹理',
    '龙舟鼓手，红色头巾，肌肉线条，江面',
    '宫廷画师，画卷，朱砂，皇宫背景',
    '禅僧打坐，僧袍，古寺，晨钟暮鼓',
    '风筝匠人，彩色风筝，老手艺，蓝天',
    '古代女将军，银甲红缨，英姿飒爽',
    '灶王爷形象，喜庆，糖瓜，年味背景',
    '长安少年，骑马，春风得意，城门背景',
  ],
  '科幻潮流': [
    '赛博朋克风男性，霓虹灯光，机械臂',
    '朋克少女，彩色短发，铆钉夹克，墨镜',
    '宇航员，太空服，头盔反光，星空背景',
    '蒸汽朋克绅士，礼帽，齿轮装饰单片眼镜',
    '街舞少年，嘻哈风，棒球帽反戴，涂鸦背景',
    '未来战士，全息护甲，激光剑，太空站',
    '虚拟偶像，渐变色头发，发光瞳孔，舞台',
    '机械少女，半人半机器，金属翅膀',
    'AI助手形象，简约白色外形，蓝色光环',
    '太空探险家，酷炫头盔，异星地表',
    '黑客帝国风格，长风衣，数据雨，墨镜',
    '生化改造人，透明皮肤下电路纹路',
    '太空海盗船长，机械义眼，等离子枪',
    '全息投影歌姬，半透明身体，数据粒子',
    '纳米战甲战士，流体金属，变形中',
    '时空旅行者，怀表齿轮，多维裂缝背景',
    '克隆人觉醒，培养皿破碎，电子编号',
    '外星大使，优雅异形面孔，水晶飞船',
    '深海机甲驾驶员，水压战甲，深渊发光生物',
    '量子物理学家，公式光环，粒子加速器',
    '废土末日幸存者，防毒面具，改装武器',
    '火星殖民者，红色沙尘，圆顶基地',
    'DNA黑客，基因编辑器，螺旋光带',
    '反重力滑板少年，悬浮街道，全息广告',
    '星际赏金猎人，战损盔甲，飞船驾驶舱',
    '虚拟现实测试员，VR头显，像素化身体',
    '人工智能觉醒体，类人形态，眼中宇宙',
    '太空牛仔，西部帽+太空服混搭，外星酒馆',
    '纳米医疗机器人（拟人），微观血管背景',
    '电子竞技冠军，全息奖杯，数据流披风',
    '时间管理局特工，多重时间线分身',
    '暗网情报商，全息面具，数据交易市场',
    '基因嵌合体，动物与人融合，实验室',
    '量子幽灵，半透明身体，概率云',
    '太阳帆船水手，光压推进，星云航线',
    '机械牧师，赛博教堂，电子经文',
    '重力操控者，漂浮碎石，扭曲空间',
    '记忆窃取者，脑波接口，梦境碎片',
    '星尘收集者，水晶瓶装星光，暗物质手套',
    '数字涅槃僧侣，代码佛光，量子禅定',
  ],
  '奇幻魔幻': [
    '精灵弓箭手，绿色斗篷，森林，尖耳',
    '矮人铁匠，大胡子，战锤，地下城',
    '黑暗巫师，骷髅法杖，黑雾缭绕',
    '兽人战士，獠牙，兽皮，战斧',
    '半龙人骑士，龙鳞铠甲，龙翼微展',
    '树人守卫，苔藓覆身，发光果实',
    '暗夜刺客，双匕首，影子融合',
    '凤凰涅槃，浴火重生，金红羽翅',
    '冰霜巨人，蓝色皮肤，冰晶王冠',
    '德鲁伊长老，鹿角，自然之力',
    '女武神瓦尔基里，翼盔，天马，北极光',
    '地精工程师，超大护目镜，炸弹背包',
    '石像鬼守护者，石质翅膀，哥特建筑顶端',
    '海妖塞壬，歌声波纹，礁石，迷雾',
    '狮鹫骑士，翱翔云端，骑枪',
    '影子商人，无面，黑雾身体，契约书',
    '沙漠法老复活，黄金面具，沙暴',
    '世界树精灵，树冠城市，叶脉发光',
    '深渊领主，裂缝王座，熔岩与黑暗',
    '命运织工，时间线丝线，织布机',
    '独眼巨人牧羊者，巨型羊群，山洞',
    '九头蛇守关者，沼泽毒雾，每头不同表情',
    '光明圣女，金色长发，治愈之光',
    '血族伯爵，红酒杯，古堡大厅，月光',
    '元素傀儡，四色拼接身体，符文核心',
    '梦魇骑士，噩梦战马，暗紫火焰',
    '天空之城居民，浮空石板，风之翼',
    '炼狱审判官，锁链，天平，火焰法庭',
    '蘑菇族村民，蘑菇帽房屋，菌丝小路',
    '星辰巨龙，宇宙鳞片，星云吐息',
    '魔法图书馆管理员，飞行书本环绕',
    '沙漏使者，时间碎片身体，过去未来交织',
    '水晶龙幼崽，透明翅膀，矿洞宝石',
    '暗影猎手，灵魂猎犬，幽冥灯笼',
    '花语巫女，花瓣符咒，荆棘结界',
    '雷霆战神，电弧锤，暴风乌云',
    '沉船幽灵船长，幽灵船，磷火',
    '契约恶魔，西装革履，黑色名片',
    '守墓人，铁铲，乌鸦，迷雾墓园',
    '月光狼人变身中，撕裂衬衫，满月',
  ],
  '生活场景': [
    '咖啡店女孩，拿铁拉花，窗边阳光，慵懒',
    '图书馆学生，堆满书桌，台灯，认真看书',
    '公园跑步者，运动耳机，晨光小路',
    '地铁通勤族，耳机，手机，车厢内',
    '花园浇花的老奶奶，草帽，玫瑰园',
    '海边冲浪少年，冲浪板，浪花，阳光',
    '雨天打伞女孩，红伞，水洼倒影，城市街道',
    '露营帐篷旁弹吉他，篝火，星空，森林',
    '菜市场买菜阿姨，布袋，新鲜蔬果',
    '骑自行车上学少年，树荫道路，书包',
    '工作中的插画师，手绘板，彩色屏幕',
    '做蛋糕的小女孩，面粉脸上，厨房',
    '遛狗青年，金毛犬，公园草地，飞盘',
    '弹钢琴的男孩，黑色三角钢琴，舞台',
    '看日落的情侣背影，海边栈桥',
    '夜市摆摊小哥，烧烤，烟火气',
    '阳台种花的文艺女生，多肉植物，阳光',
    '打篮球的少年，投篮瞬间，操场',
    '下棋的爷孙俩，公园石桌，树荫下',
    '雪地里堆雪人的孩子，红围巾，胡萝卜鼻子',
    '钓鱼老人，河边，竹竿，斗笠，悠闲',
    '旅行背包客，机场大厅，世界地图',
    '街角画肖像的画师，画架，路人模特',
    '深夜加班程序员，多屏幕，外卖盒，凌晨',
    '婚纱照新娘，白纱，捧花，幸福微笑',
    '毕业季学生，学士帽，毕业照，校园',
    '集市卖花少女，花束，自行车后座满花',
    '清晨练太极的老人，公园湖边，雾气',
    '小孩放风筝，草地，蓝天白云，奔跑',
    '窗边看雨发呆的少女，热茶杯，毛毯',
  ],
  '萌宠动物': [
    '橘猫，慵懒趴着，阳光窗台，微眯眼',
    '柴犬，歪头卖萌，伸舌头，草地背景',
    '白色布偶猫，蓝眼睛，蝴蝶结，沙发上',
    '金毛幼犬，叼飞盘，欢快奔跑，公园',
    '英短蓝猫，圆脸大眼，毛线球，地毯',
    '哈士奇，拆家表情，沙发棉花满地',
    '小兔子，竖耳朵，吃胡萝卜，花园',
    '龙猫（毛丝鼠），灰色圆润，手捧零食',
    '鹦鹉，彩色羽毛，站在肩膀上，说话',
    '小刺猬，卷成球，手心里，毛茸茸',
    '锦鲤，红白花纹，池塘荷叶，水面波纹',
    '柯基，短腿奔跑，屁股摇摆，草坪',
    '暹罗猫，蓝眼重点色，优雅坐姿',
    '小仓鼠，塞满腮帮，跑轮上运动',
    '拉布拉多导盲犬，工作背心，认真表情',
    '波斯猫，长毛雪白，趴在书本上',
    '边境牧羊犬，聪明眼神，叼着球',
    '小鸭子排队，黄色绒毛，池塘边',
    '猫头鹰，大眼转头，树枝月光',
    '泰迪犬，棕色卷毛，穿小衣服，街拍',
    '苏格兰折耳猫，圆耳朵，坐立仰望',
    '萨摩耶，白色微笑天使，雪地奔跑',
    '小松鼠，抱松果，树枝上蹲坐',
    '法斗犬，呆萌表情，蝴蝶结领带',
    '狸花猫，跳跃抓蝴蝶，阳光草地',
    '阿拉斯加雪橇犬，拉雪橇，暴风雪',
    '异国短毛猫，扁脸大眼，呆萌表情',
    '小狐狸，红色毛发，雪地里回头看',
    '比熊犬，棉花糖般蓬松，微笑',
    '花斑猫，窗台看窗外下雨，忧郁文艺',
    '羊驼，蓬松毛发，歪嘴表情，牧场',
    '黑猫，月光下绿眼发光，屋顶',
    '贵宾犬，造型剪毛，贵族气质',
    '鸳鸯一对，池塘莲花，成双入对',
    '三花猫，伸懒腰，尾巴翘起，书架旁',
    '小熊猫（红熊猫），抱树枝，圆脸红棕色',
    '德牧，警犬训练，跳跃障碍',
    '奶牛猫，搞怪表情，纸箱里探头',
    '大白鹅，伸脖子，河边嘎嘎叫',
    '蝴蝶犬，大耳朵飘逸，花丛中奔跑',
  ],
  '节日主题': [
    '春节拜年娃娃，红色唐装，鞭炮灯笼',
    '圣诞老人，红衣白胡子，礼物袋，雪夜',
    '万圣节女巫，南瓜灯，黑猫，月夜',
    '元宵节少女，手提花灯，猜灯谜，月圆',
    '情人节情侣，玫瑰花束，心形气球',
    '中秋嫦娥，广袖飘飘，月饼玉兔，月宫',
    '端午节粽子拟人，龙舟背景，艾草',
    '儿童节小朋友，气球彩旗，游乐场',
    '感恩节家庭聚餐，火鸡，温馨餐桌',
    '复活节兔子，彩蛋篮子，春日花园',
    '七夕织女，鹊桥银河，星光裙摆',
    '母亲节妈妈，康乃馨，温柔拥抱孩子',
    '新年倒计时，香槟气泡，烟花夜空',
    '清明踏青少女，青团，柳树，春雨',
    '国庆阅兵战士，红旗，天安门广场',
    '教师节学生送花，黑板，感恩二字',
    '重阳节老人登高，菊花，秋山远眺',
    '植树节少年，铲子树苗，春日阳光',
    '丰收节农民，金色稻田，笑容满面',
    '除夕年夜饭，全家围坐，红色春联',
    '元旦庆祝，2026字样，彩带香槟',
    '腊八节小和尚，腊八粥，寺庙晨光',
    '冬至吃饺子，热气腾腾，家庭温馨',
    '花朝节少女，百花簪，春日花海',
    '圣诞精灵，绿色制服，礼物工坊',
    '中元节孔明灯，河边放灯，星光倒影',
    '狂欢节舞者，面具羽毛，彩色盛装',
    '樱花祭和服少女，粉色花瓣飘落',
    '丰年祭原住民，传统服饰，篝火舞蹈',
    '冰雪节冰雕师，彩灯冰城，北国风光',
    '开学季新生，校门口，新书包，期待',
    '生日派对主角，蛋糕蜡烛，彩色气球',
    '婚礼新人，中式凤冠霞帔，红色喜庆',
    '毕业典礼，学士服抛帽，青春笑脸',
    '乔迁新居，钥匙开门，新家期待',
  ],
};

const AI_EDIT_PROMPTS: Record<string, string[]> = {
  '外观': [
    '换成职业装', '改为长发', '换成短发', '加上眼镜', '加上帽子',
    '加上耳环', '加上围巾', '衣服换成红色', '头发改为黑色', '发型改为丸子头',
    '换成连衣裙', '加上项链', '改为卷发', '加上手表', '衣服换成白色',
    '换成牛仔外套', '改为金色长发', '加上发带', '换成运动装', '穿上高跟鞋',
    '换成格子衬衫', '头发挑染彩色', '戴上棒球帽', '换成皮夹克', '穿上卫衣',
  ],
  '表情动作': [
    '表情更严肃', '表情更开心', '改为侧脸', '改为闭眼微笑', '做出比心手势',
    '双手抱胸', '单手托腮', '做出胜利手势', '回头微笑', '仰望天空',
    '低头看书', '开怀大笑', '神秘微笑', '认真思考表情', '歪头卖萌',
    '挥手打招呼', '叉腰站立', '奔跑姿态', '坐姿放松', '倚靠墙壁',
  ],
  '风格': [
    '改为卡通风格', '改为动漫风格', '改为水彩画风格', '改为像素风',
    '改为油画质感', '改为扁平插画风', '改为3D渲染风格', '改为素描风格',
    '改为赛博朋克风', '改为国风水墨', '改为极简线条风', '改为复古海报风',
    '改为波普艺术风', '改为浮世绘风格', '改为低多边形风格', '改为蒸汽波风',
    '改为暗黑哥特风', '改为童话绘本风', '改为霓虹光效风', '改为黏土定格风',
  ],
  '背景': [
    '背景换白色', '背景换成办公室', '背景换成户外', '背景换渐变色',
    '换成蓝色背景', '背景换成星空', '背景换成城市夜景', '背景改为纯黑',
    '背景换成海边', '背景换成樱花树', '背景换成图书馆', '背景换成咖啡馆',
    '背景换成雪山', '背景换成日落', '背景换成花园', '背景换成赛博城市',
    '背景换成古镇', '背景换成画室', '背景换成月球表面', '背景换成水下',
  ],
  '光影色调': [
    '整体更明亮', '色调更暖', '画面更精致', '加上电影感光影',
    '逆光效果', '金色夕阳光', '冷色调蓝紫', '加强对比度',
    '柔焦梦幻感', '硬光线条感', '霓虹灯光效', '烛光暖黄氛围',
    '月光清冷感', '彩虹光斑', '暗调高级感', '阳光斑驳树影',
    '雾气朦胧感', '荧光发光效果', '黑白高对比', '复古胶片色调',
  ],
  '构图视角': [
    '改为半身特写', '改为全身照', '俯拍视角', '仰拍视角',
    '侧面剪影', '对称构图', '三分法构图', '极简留白',
    '微距特写脸部', '远景全身小人', '鸟瞰俯视', '低角度仰视',
    '居中对称', '黄金螺旋构图', '前景虚化', '画中画构图',
    '镜像倒影', '剪影逆光', '斜角荷兰角', '大头贴特写',
    '膝盖以上半身', '肩部以上近照', '背影构图', '回眸侧脸',
    '双人并排构图',
  ],
  '特效装饰': [
    '加上樱花飘落', '加上雪花效果', '加上星光粒子', '加上蝴蝶环绕',
    '加上光圈光斑', '加上水滴效果', '加上火焰特效', '加上电光效果',
    '加上花瓣雨', '加上彩色泡泡', '加上金色光粉', '加上音符飘浮',
    '加上落叶效果', '加上烟雾缭绕', '加上水墨晕染', '加上几何线条',
    '加上光束穿透', '加上萤火虫光点', '加上碎片化边缘', '加上全息光效',
    '加上羽毛飘散', '加上雨滴涟漪', '加上极光背景', '加上玫瑰花瓣',
    '加上数据流粒子',
  ],
};

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [project, setProject] = useState<Project | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [subjects, setSubjects] = useState<ProjectSubject[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newVideoName, setNewVideoName] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showAddSubject, setShowAddSubject] = useState(false);
  const [addMode, setAddMode] = useState<AddMode>('real');
  const [newSubjectLabel, setNewSubjectLabel] = useState('');
  const [newSubjectDesc, setNewSubjectDesc] = useState('');
  const [newSubjectImage, setNewSubjectImage] = useState('');
  const [uploading, setUploading] = useState(false);
  const [assetGroups, setAssetGroups] = useState<AssetGroup[]>([]);
  const [assetItemsByGroup, setAssetItemsByGroup] = useState<Record<string, Asset[]>>({});
  const [assetLoading, setAssetLoading] = useState(false);
  const [pickedAsset, setPickedAsset] = useState<{ image_url: string; asset_id?: string; defaultLabel: string } | null>(null);
  const [editingSubject, setEditingSubject] = useState<string | null>(null);
  const [avatars, setAvatars] = useState<Array<{ assetId: string; label: string; thumb: string }>>([]);
  const [avatarSearch, setAvatarSearch] = useState('');
  const [labelError, setLabelError] = useState(false);

  // AI创作 chat state
  const [showAiChat, setShowAiChat] = useState(false);
  const [aiTurns, setAiTurns] = useState<Array<{ id: number; role: 'user' | 'assistant'; text?: string; image?: string; description?: string; refPreviews?: string[]; loading?: boolean; error?: string }>>([]);
  const [aiInput, setAiInput] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiLastImage, setAiLastImage] = useState<string | null>(null);
  const [aiRefImages, setAiRefImages] = useState<Array<{ file: File; preview: string }>>([]);
  const [showAiPrompts, setShowAiPrompts] = useState(false);
  const [aiPromptSeed, setAiPromptSeed] = useState(0);
  const [aiPromptTab, setAiPromptTab] = useState('');
  const [subjectPage, setSubjectPage] = useState(0);
  const [videoPage, setVideoPage] = useState(0);
  const PAGE_SIZE = 8;
  const aiBottomRef = useRef<HTMLDivElement>(null);
  const aiFileRef = useRef<HTMLInputElement>(null);
  const aiIdRef = useRef(0);

  useEffect(() => { aiBottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [aiTurns]);

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function aiSend(text: string) {
    const trimmed = text.trim();
    if (!trimmed || aiBusy) return;
    const userId = ++aiIdRef.current;
    const assistantId = ++aiIdRef.current;
    const refPreviews = aiRefImages.map(r => r.preview);
    setAiTurns(prev => [...prev, { id: userId, role: 'user', text: trimmed, refPreviews: refPreviews.length > 0 ? refPreviews : undefined }, { id: assistantId, role: 'assistant', loading: true }]);
    setAiInput('');
    setAiBusy(true);
    const currentRefImages = [...aiRefImages];
    setAiRefImages([]);
    try {
      const { getAccessToken } = await import('@/lib/auth');
      const token = getAccessToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const body: Record<string, unknown> = { prompt: trimmed };
      if (aiLastImage) {
        const m = aiLastImage.match(/^data:([^;]+);base64,(.*)$/);
        if (m) body.priorImage = { mimeType: m[1], data: m[2] };
        else body.priorImageUrl = aiLastImage;
      }
      // Attach reference images
      if (currentRefImages.length > 0) {
        const refImgs: Array<{ mimeType: string; data: string }> = [];
        for (const item of currentRefImages) {
          const dataUrl = await fileToBase64(item.file);
          const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
          if (match) refImgs.push({ mimeType: match[1], data: match[2] });
        }
        if (refImgs.length > 0) body.referenceImages = refImgs;
      }
      const res = await fetch('/api/voiceover/ai-image', { method: 'POST', headers, body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || '生成失败');
      const image = json.data.image;
      const aiDesc = json.data.description || '';
      setAiLastImage(image);
      setAiTurns(prev => prev.map(t => t.id === assistantId ? { ...t, loading: false, image, description: aiDesc } : t));
    } catch (e) {
      const msg = e instanceof Error ? e.message : '生成失败，请重试';
      setAiTurns(prev => prev.map(t => t.id === assistantId ? { ...t, loading: false, error: msg } : t));
    } finally {
      setAiBusy(false);
    }
  }

  function aiUseImage(imageUrl: string, description?: string) {
    setPickedAsset({ image_url: imageUrl, defaultLabel: '' });
    setNewSubjectImage(imageUrl);
    if (description) setNewSubjectDesc(description);
    setShowAiChat(false);
  }

  const loadData = useCallback(async () => {
    try {
      const [proj, vids, subs] = await Promise.all([
        api.get<Project>(`/projects/${projectId}`),
        api.get<Video[]>(`/projects/${projectId}/videos`),
        api.get<ProjectSubject[]>(`/projects/${projectId}/subjects`),
      ]);
      setProject(proj);
      setVideos(vids || []);
      setSubjects(subs || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => { fetch('/avatars/index.json').then(r => r.json()).then(d => setAvatars(d.reverse())).catch(() => {}); }, []);

  async function handleCreateVideo() {
    if (!newVideoName.trim()) return;
    setCreating(true);
    try {
      const data = await api.post<Video>(`/projects/${projectId}/videos`, { name: newVideoName.trim() });
      if (data?.id) {
        router.push(`/voiceover-v3?projectId=${projectId}&videoId=${data.id}`);
      }
    } catch {
      // ignore
    } finally {
      setCreating(false);
    }
  }

  async function handleDeleteVideo(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (!confirm('确定删除该视频？所有分镜将一并删除。')) return;
    try {
      await api.del(`/videos/${id}`);
      setVideos(prev => prev.filter(v => v.id !== id));
    } catch {
      // ignore
    }
  }

  async function handleAddSubject() {
    if (!newSubjectLabel.trim()) { setLabelError(true); return; }
    try {
      const data = await api.post<ProjectSubject>(`/projects/${projectId}/subjects`, {
        label: newSubjectLabel.trim(),
        description: newSubjectDesc.trim() || null,
        image_url: newSubjectImage.trim() || null,
      });
      if (data) setSubjects(prev => [...prev, data]);
      setNewSubjectLabel('');
      setNewSubjectDesc('');
      setNewSubjectImage('');
      setShowAddSubject(false);
    } catch {}
  }

  async function handleUploadImage(file: File) {
    setUploading(true);
    try {
      const { getAccessToken } = await import('@/lib/auth');
      const headers: Record<string, string> = {};
      const token = getAccessToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/upload', { method: 'POST', body: form, headers });
      const json = await res.json();
      if (json.success) {
        setNewSubjectImage(json.data.url);
      }
    } catch {}
    setUploading(false);
  }

  async function loadAssetGroups(type: 'LivenessFace' | 'AIGC') {
    setAssetLoading(true);
    setAssetItemsByGroup({});
    const region = type === 'AIGC' ? 'cn' : '';
    const regionParam = region ? `&region=${region}` : '';
    try {
      const res = await api.get<{ Items: AssetGroup[] }>(`/assets/groups?groupType=${type}${regionParam}`);
      const groups = res.Items || [];
      setAssetGroups(groups);
      const allItems: Record<string, Asset[]> = {};
      await Promise.all(groups.map(async (g) => {
        try {
          const r = await api.get<{ Items: Asset[] }>(`/assets/groups/${g.Id}/assets${region ? `?region=${region}` : ''}`);
          const items = r.Items || [];
          const enriched = await Promise.all(items.filter(a => a.AssetType === 'Image').map(async (item) => {
            try {
              const detail = await api.get<{ URL?: string }>(`/assets/item/${item.Id}${region ? `?region=${region}` : ''}`);
              return { ...item, URL: detail.URL || item.PreviewUrl };
            } catch { return item; }
          }));
          allItems[g.Id] = enriched;
        } catch {}
      }));
      setAssetItemsByGroup(allItems);
    } catch {}
    setAssetLoading(false);
  }

  function handleSwitchMode(mode: AddMode) {
    setAddMode(mode);
    setAssetGroups([]);
    setAssetItemsByGroup({});
    setPickedAsset(null);
    setLabelError(false);
    if (mode === 'real') loadAssetGroups('LivenessFace');
    else if (mode === 'virtual') loadAssetGroups('AIGC');
  }

  async function handleUpdateSubject(id: string, fields: Partial<ProjectSubject>) {
    if (fields.label !== undefined && !fields.label.trim()) { setEditingSubject(null); return; }
    try {
      const data = await api.put<ProjectSubject>(`/subjects/${id}`, fields);
      if (data) setSubjects(prev => prev.map(s => s.id === id ? { ...s, ...data } : s));
    } catch {}
    setEditingSubject(null);
  }

  async function handleDeleteSubject(id: string) {
    if (!confirm('删除主体后，引用该主体的视频和分镜将失去关联。确定删除？')) return;
    try {
      await api.del(`/subjects/${id}`);
      setSubjects(prev => prev.filter(s => s.id !== id));
    } catch {}
  }

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>加载中...</div>;
  if (!project) return <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>项目不存在</div>;

  return (
    <>
      <div className={styles.breadcrumb}>
        <Link href="/projects" style={{ padding: '2px 4px' }}>项目库</Link>
        <span className={styles.sep}>&gt;</span>
        <span style={{ padding: '2px 4px' }}>{project.name}</span>
      </div>
    <div className={styles.container}>

      {/* Subject Library */}
      <section className={styles.subjectSection}>
        <div className={styles.subjectHeader}>
          <h2 className={styles.subjectTitle}>角色 ({subjects.length}个)</h2>
          <button className={styles.addSubjectBtn} onClick={() => setShowAddSubject(true)}>+ 添加角色</button>
        </div>

        {showAddSubject && (
          <div className={styles.addSubjectForm}>
            <div className={styles.addModeTabs}>
              {/* <button className={`${styles.modeTab} ${addMode === 'manual' ? styles.modeTabActive : ''}`} onClick={() => handleSwitchMode('manual')}>手动创建</button> */}
              <button className={`${styles.modeTab} ${addMode === 'real' ? styles.modeTabActive : ''}`} onClick={() => handleSwitchMode('real')}>真人头像</button>
              <button className={`${styles.modeTab} ${addMode === 'virtual' ? styles.modeTabActive : ''}`} onClick={() => handleSwitchMode('virtual')}>虚拟人像</button>
              <button className={`${styles.modeTab} ${addMode === 'avatar' ? styles.modeTabActive : ''}`} onClick={() => { setAddMode('avatar'); setAssetGroups([]); setAssetItemsByGroup({}); }}>备用库</button>
            </div>

            {addMode === 'manual' && (
              <>
                <div className={styles.imageRow}>
                  <input
                    className={styles.subjectInput}
                    style={labelError ? { borderColor: '#ef4444' } : undefined}
                    placeholder="角色名称*"
                    value={newSubjectLabel}
                    onChange={e => { setNewSubjectLabel(e.target.value); setLabelError(false); }}
                    autoFocus
                  />
                  <input
                    className={styles.subjectInput}
                    placeholder="参考图片URL（可选）"
                    value={newSubjectImage}
                    onChange={e => setNewSubjectImage(e.target.value)}
                  />
                  <label className={styles.uploadLabel}>
                    {uploading ? '上传中...' : '上传图片'}
                    <input type="file" accept="image/*" style={{ display: 'none' }}
                      onChange={e => { const f = e.target.files?.[0]; if (f) handleUploadImage(f); e.target.value = ''; }}
                    />
                  </label>
                </div>
                {labelError && <span style={{ color: '#ef4444', fontSize: 12 }}>请输入角色名称</span>}
                <input
                  className={styles.subjectInput}
                  placeholder="外貌性格描述"
                  value={newSubjectDesc}
                  onChange={e => setNewSubjectDesc(e.target.value)}
                />
                {newSubjectImage && (
                  <img src={newSubjectImage} alt="" className={styles.previewThumb} />
                )}
                <div className={styles.addSubjectActions}>
                  <button className={styles.createConfirm} onClick={handleAddSubject}>添加</button>
                  <button className={styles.createCancel} onClick={() => setShowAddSubject(false)}>取消</button>
                </div>
              </>
            )}

            {addMode === 'avatar' && !pickedAsset && (
              <div className={styles.assetPickerWrap}>
                <input type="text" placeholder="搜索职业、国籍、年龄…" value={avatarSearch}
                  onChange={e => setAvatarSearch(e.target.value)}
                  className={styles.subjectInput} style={{ marginBottom: 8 }} />
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(68px, 1fr))', gap: 6, maxHeight: 280, overflowY: 'auto' }}>
                  {(avatarSearch.trim() ? avatars.filter(a => a.label.includes(avatarSearch.trim())) : avatars).slice(0, 100).map(av => (
                    <div key={av.assetId}
                      onClick={() => {
                        setPickedAsset({ image_url: av.thumb, asset_id: av.assetId, defaultLabel: av.label.replace(/_/g, ' ') });
                        setNewSubjectLabel(av.label.replace(/_/g, ' '));
                        setNewSubjectImage(av.thumb);
                      }}
                      style={{ position: 'relative', borderRadius: 6, overflow: 'hidden', cursor: 'pointer', border: '1px solid #e5e7eb', aspectRatio: '3/4', background: '#f8fafc' }}>
                      <img src={av.thumb} alt={av.label} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'linear-gradient(transparent, rgba(0,0,0,.6))', padding: '10px 3px 2px', fontSize: 9, color: '#fff', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {av.label.replace(/_/g, ' ')}
                      </div>
                    </div>
                  ))}
                </div>
                <div className={styles.addSubjectActions}>
                  <button className={styles.createCancel} onClick={() => setShowAddSubject(false)}>关闭</button>
                </div>
              </div>
            )}

            {(addMode === 'real' || addMode === 'virtual') && !pickedAsset && (
              <div className={styles.assetPickerWrap}>
                {assetLoading && <span style={{ color: '#ef4444', fontSize: 13 }}>加载中...</span>}
                {!assetLoading && assetGroups.length === 0 && (
                  <span className={styles.muted}>暂无{addMode === 'real' ? '真人头像' : '虚拟人像'}资源</span>
                )}
                {assetGroups.map((g, gi) => {
                  const items = assetItemsByGroup[g.Id] || [];
                  return (
                    <div key={g.Id} style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>
                        {g.Name || `${addMode === 'real' ? '真人头像' : '虚拟人像'}组${gi + 1}`}
                      </div>
                      {items.length === 0 && !assetLoading && (
                        <span className={styles.muted} style={{ fontSize: 11 }}>暂无素材</span>
                      )}
                      <div className={styles.assetPickerGrid}>
                        {items.map(asset => (
                          <div key={asset.Id} className={styles.assetPickerCard} onClick={() => {
                            const imageUrl = asset.URL || asset.PreviewUrl || '';
                            setPickedAsset({ image_url: imageUrl, asset_id: asset.Id, defaultLabel: '' });
                            setNewSubjectImage(imageUrl);
                          }}>
                            {(asset.URL || asset.PreviewUrl) && (
                              <img src={asset.URL || asset.PreviewUrl} alt="" className={styles.assetPickerImg} />
                            )}
                            <span className={styles.assetPickerName}>{asset.Name || asset.Id.slice(0, 8)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
                <div className={styles.addSubjectActions}>
                  <button className={styles.createCancel} onClick={() => setShowAddSubject(false)}>关闭</button>
                </div>
              </div>
            )}

            {(addMode !== 'manual') && pickedAsset && (
              <div className={styles.assetPickerWrap}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  {pickedAsset.image_url && <img src={pickedAsset.image_url} alt="" className={styles.previewThumb} />}
                  <span style={{ fontSize: 12, color: '#6b7280' }}>已选择素材</span>
                  <button className={styles.createCancel} style={{ marginLeft: 'auto', padding: '2px 8px', fontSize: 11 }} onClick={() => { setPickedAsset(null); setNewSubjectLabel(''); setNewSubjectDesc(''); setNewSubjectImage(''); }}>重选</button>
                </div>
                <input
                  className={styles.subjectInput}
                  style={labelError ? { borderColor: '#ef4444' } : undefined}
                  placeholder="角色名称 *"
                  value={newSubjectLabel}
                  onChange={e => { setNewSubjectLabel(e.target.value); setLabelError(false); }}
                  autoFocus
                />
                {labelError && <span style={{ color: '#ef4444', fontSize: 12 }}>请输入角色名称</span>}
                <input
                  className={styles.subjectInput}
                  placeholder="外貌性格描述"
                  value={newSubjectDesc}
                  onChange={e => setNewSubjectDesc(e.target.value)}
                />
                <div className={styles.addSubjectActions}>
                  <button className={styles.createConfirm} onClick={async () => {
                    if (!newSubjectLabel.trim()) { setLabelError(true); return; }
                    try {
                      const data = await api.post<ProjectSubject>(`/projects/${projectId}/subjects`, {
                        label: newSubjectLabel.trim(),
                        description: newSubjectDesc.trim() || null,
                        image_url: pickedAsset.image_url || null,
                        asset_id: pickedAsset.asset_id || null,
                      });
                      if (data) setSubjects(prev => [...prev, data]);
                      setPickedAsset(null);
                      setNewSubjectLabel('');
                      setNewSubjectDesc('');
                      setNewSubjectImage('');
                      setShowAddSubject(false);
                    } catch {}
                  }} disabled={!newSubjectLabel.trim()}>确认添加</button>
                  <button className={styles.createCancel} onClick={() => { setPickedAsset(null); setShowAddSubject(false); }}>取消</button>
                </div>
              </div>
            )}

            {showAiChat && (
              <div className={styles.aiOverlay} onClick={() => setShowAiChat(false)}>
                <div className={styles.aiModal} onClick={e => e.stopPropagation()}>
                  <div className={styles.aiHeader}>
                    <span className={styles.aiTitle}>AI创作角色</span>
                    <div className={styles.aiHeaderRight}>
                      {aiTurns.length > 0 && (
                        <button className={styles.aiClearBtn} onClick={() => { setAiTurns([]); setAiLastImage(null); setAiRefImages([]); }}>清空对话</button>
                      )}
                      <button className={styles.aiClose} onClick={() => setShowAiChat(false)}>×</button>
                    </div>
                  </div>
                  <div className={styles.aiBody}>
                    {aiTurns.length === 0 ? (
                      <div className={styles.aiEmpty}>
                        <div style={{ fontSize: 32, opacity: 0.3, marginBottom: 8 }}>🎨</div>
                        描述你想要的角色形象，AI会为你生成图片。<br/>生成后可继续修改（换服装/改发型/调风格）。
                      </div>
                    ) : (
                      aiTurns.map(t => (
                        <div key={t.id} className={t.role === 'user' ? styles.aiMsgUser : styles.aiMsgBot}>
                          {t.role === 'user' ? (
                            <div className={styles.aiBubbleUser}>
                              {t.text}
                              {t.refPreviews && t.refPreviews.length > 0 && (
                                <div className={styles.aiMsgRefRow}>
                                  {t.refPreviews.map((src, i) => (
                                    <img key={i} src={src} alt="" className={styles.aiMsgRefThumb} />
                                  ))}
                                </div>
                              )}
                            </div>
                          ) : t.loading ? (
                            <div className={styles.aiBubbleBot}>正在生成图片，请稍候…</div>
                          ) : t.error ? (
                            <div className={styles.aiBubbleBotErr}>{t.error}</div>
                          ) : (
                            <div className={styles.aiBubbleBotImg}>
                              <img src={t.image} alt="生成结果" className={styles.aiGenImg} />
                              <button className={styles.aiUseBtn} onClick={() => {
                                const tIdx = aiTurns.indexOf(t);
                                const userTurn = tIdx > 0 ? aiTurns[tIdx - 1] : null;
                                const desc = t.description || (userTurn?.role === 'user' ? userTurn.text || '' : '');
                                aiUseImage(t.image!, desc);
                              }}>使用此图片</button>
                            </div>
                          )}
                        </div>
                      ))
                    )}
                    <div ref={aiBottomRef} />
                  </div>
                  <div className={styles.aiChips}>
                    {showAiPrompts && (
                      <div className={styles.aiPromptPanel}>
                        <div className={styles.aiPromptTabs}>
                          {Object.keys(aiLastImage ? AI_EDIT_PROMPTS : AI_CREATE_PROMPTS).map(cat => (
                            <button key={cat} className={`${styles.aiPromptTabBtn} ${aiPromptTab === cat ? styles.aiPromptTabActive : ''}`} onClick={() => setAiPromptTab(cat)}>{cat}</button>
                          ))}
                        </div>
                        <div className={styles.aiPromptList}>
                          {(() => {
                            const source = aiLastImage ? AI_EDIT_PROMPTS : AI_CREATE_PROMPTS;
                            const arr = aiPromptTab && source[aiPromptTab] ? [...source[aiPromptTab]] : Object.values(source).flat();
                            for (let i = arr.length - 1; i > 0; i--) { const j = (i * (aiPromptSeed + 1) * 7 + 13) % (i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; }
                            return arr.slice(0, 20);
                          })().map(p => (
                            <button key={p} className={styles.aiChip} onClick={() => { setAiInput(p); setShowAiPrompts(false); }}>{p}</button>
                          ))}
                        </div>
                        <button className={styles.aiRefreshBtn} onClick={() => setAiPromptSeed(v => v + 1)}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
                          换一批
                        </button>
                      </div>
                    )}
                    <button className={styles.aiPromptToggle} onClick={() => setShowAiPrompts(v => !v)} title="提示词">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: showAiPrompts ? 'rotate(180deg)' : 'none' }}><polyline points="18 15 12 9 6 15"/></svg>
                      <span>提示词</span>
                    </button>
                  </div>
                  <div className={styles.aiInputRow}>
                    <label className={styles.aiAttachBtn} title="上传参考图">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
                      <input ref={aiFileRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => {
                        const files = Array.from(e.target.files || []);
                        const newItems = files.map(f => ({ file: f, preview: URL.createObjectURL(f) }));
                        setAiRefImages(prev => [...prev, ...newItems].slice(0, 5));
                        e.target.value = '';
                      }} />
                    </label>
                    <textarea
                      className={styles.aiTextarea}
                      rows={2}
                      value={aiInput}
                      onChange={e => setAiInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiSend(aiInput); } }}
                      disabled={aiBusy}
                      placeholder={aiLastImage ? '继续修改，如「换成蓝色背景」…' : '描述你想要的角色形象…'}
                    />
                    <button className={styles.aiSendBtn} onClick={() => aiSend(aiInput)} disabled={aiBusy || !aiInput.trim()}>
                      {aiBusy ? '生成中…' : '发送'}
                    </button>
                  </div>
                  {aiRefImages.length > 0 && (
                    <div className={styles.aiRefRow}>
                      {aiRefImages.map((item, i) => (
                        <div key={i} className={styles.aiRefThumb}>
                          <img src={item.preview} alt="" />
                          <button className={styles.aiRefRemove} onClick={() => setAiRefImages(prev => prev.filter((_, idx) => idx !== i))}>×</button>
                        </div>
                      ))}
                      <span className={styles.aiRefHint}>参考图 {aiRefImages.length}/5</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {subjects.length > 0 && (
          <>
          <div className={styles.subjectGrid}>
            {subjects.slice(subjectPage * PAGE_SIZE, (subjectPage + 1) * PAGE_SIZE).map((subject) => (
              <div key={subject.id} className={`${styles.subjectGridItem} ${editingSubject === subject.id ? styles.subjectGridItemActive : ''}`}
                onClick={() => setEditingSubject(editingSubject === subject.id ? null : subject.id)}>
                <div className={styles.subjectGridThumbWrap}>
                  {subject.image_url ? (
                    <img src={subject.image_url} alt={subject.label} className={styles.subjectGridThumb} />
                  ) : (
                    <div className={styles.subjectGridThumbEmpty}>?</div>
                  )}
                </div>
                <span className={styles.subjectGridName}>{subject.label}</span>
              </div>
            ))}
          </div>
          {subjects.length > PAGE_SIZE && (
            <div className={styles.mobilePagination}>
              <button onClick={() => setSubjectPage(p => Math.max(0, p - 1))} disabled={subjectPage === 0}
                className={`${styles.pageBtn} ${subjectPage === 0 ? styles.pageBtnDisabled : ''}`}>上一页</button>
              <span className={styles.pageInfo}>{subjectPage + 1} / {Math.ceil(subjects.length / PAGE_SIZE)}</span>
              <button onClick={() => setSubjectPage(p => Math.min(Math.ceil(subjects.length / PAGE_SIZE) - 1, p + 1))} disabled={subjectPage >= Math.ceil(subjects.length / PAGE_SIZE) - 1}
                className={`${styles.pageBtn} ${subjectPage >= Math.ceil(subjects.length / PAGE_SIZE) - 1 ? styles.pageBtnDisabled : ''}`}>下一页</button>
            </div>
          )}
          </>
        )}

        {editingSubject && subjects.find(s => s.id === editingSubject) && (() => {
          const subject = subjects.find(s => s.id === editingSubject)!;
          return (
            <div className={styles.subjectDetailPanel}>
              <div className={styles.subjectDetailHeader}>
                <span className={styles.subjectDetailTitle}>编辑角色</span>
                <button className={styles.subjectDetailClose} onClick={() => setEditingSubject(null)}>×</button>
              </div>
              <div className={styles.subjectDetailBody}>
                <div className={styles.subjectDetailRow}>
                  <div className={styles.subjectDetailThumbWrap}>
                    {subject.image_url ? (
                      <img src={subject.image_url} alt="" className={styles.subjectDetailThumbImg} />
                    ) : (
                      <div className={styles.subjectDetailThumbEmpty}>
                        <label style={{ cursor: 'pointer', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          +
                          <input type="file" accept="image/*" style={{ display: 'none' }} onChange={async e => {
                            const f = e.target.files?.[0]; if (!f) return; e.target.value = '';
                            const form = new FormData(); form.append('file', f);
                            const { getAccessToken } = await import('@/lib/auth');
                            const headers: Record<string, string> = {};
                            const token = getAccessToken(); if (token) headers['Authorization'] = `Bearer ${token}`;
                            const res = await fetch('/api/upload', { method: 'POST', body: form, headers });
                            const json = await res.json();
                            if (json.success) handleUpdateSubject(subject.id, { image_url: json.data.url });
                          }} />
                        </label>
                      </div>
                    )}
                  </div>
                  <div className={styles.subjectDetailFields}>
                    <input
                      className={styles.subjectInput}
                      defaultValue={subject.label}
                      placeholder="角色名称"
                      onBlur={e => { if (e.target.value !== subject.label) handleUpdateSubject(subject.id, { label: e.target.value }); }}
                      onKeyDown={e => { if (e.key === 'Enter') handleUpdateSubject(subject.id, { label: (e.target as HTMLInputElement).value }); }}
                    />
                    <input
                      className={styles.subjectInput}
                      defaultValue={subject.description || ''}
                      placeholder="外貌性格描述"
                      onBlur={e => { if (e.target.value !== (subject.description || '')) handleUpdateSubject(subject.id, { description: e.target.value || null }); }}
                      onKeyDown={e => { if (e.key === 'Enter') handleUpdateSubject(subject.id, { description: (e.target as HTMLInputElement).value || null }); }}
                    />
                  </div>
                </div>
                <div className={styles.subjectDetailMediaRow}>
                  {subject.action_url ? (
                    <span className={styles.subjectMediaTag} title={subject.action_url}>
                      动作 ✓
                      <button className={styles.subjectMediaRemove} onClick={() => handleUpdateSubject(subject.id, { action_url: null as unknown as string })}>×</button>
                    </span>
                  ) : (
                    <label className={styles.subjectMediaUpload}>
                      + 动作
                      <input type="file" accept="video/*,image/*" style={{ display: 'none' }} onChange={async e => {
                        const f = e.target.files?.[0]; if (!f) return; e.target.value = '';
                        const form = new FormData(); form.append('file', f);
                        const { getAccessToken } = await import('@/lib/auth');
                        const headers: Record<string, string> = {};
                        const token = getAccessToken(); if (token) headers['Authorization'] = `Bearer ${token}`;
                        const res = await fetch('/api/upload', { method: 'POST', body: form, headers });
                        const json = await res.json();
                        if (json.success) handleUpdateSubject(subject.id, { action_url: json.data.url });
                      }} />
                    </label>
                  )}
                  {subject.sound_url ? (
                    <span className={styles.subjectMediaTag} title={subject.sound_url}>
                      音效 ✓
                      <button className={styles.subjectMediaRemove} onClick={() => handleUpdateSubject(subject.id, { sound_url: null as unknown as string })}>×</button>
                    </span>
                  ) : (
                    <label className={styles.subjectMediaUpload}>
                      + 音效
                      <input type="file" accept="audio/*" style={{ display: 'none' }} onChange={async e => {
                        const f = e.target.files?.[0]; if (!f) return; e.target.value = '';
                        const form = new FormData(); form.append('file', f);
                        const { getAccessToken } = await import('@/lib/auth');
                        const headers: Record<string, string> = {};
                        const token = getAccessToken(); if (token) headers['Authorization'] = `Bearer ${token}`;
                        const res = await fetch('/api/upload', { method: 'POST', body: form, headers });
                        const json = await res.json();
                        if (json.success) handleUpdateSubject(subject.id, { sound_url: json.data.url });
                      }} />
                    </label>
                  )}
                  <button className={styles.subjectDeleteBtnVisible} onClick={() => { handleDeleteSubject(subject.id); setEditingSubject(null); }}>删除角色</button>
                </div>
              </div>
            </div>
          );
        })()}
      </section>

      {/* Video List */}
      <section className={styles.videoSection}>
        <div className={styles.subjectHeader}>
          <h2 className={styles.subjectTitle}>本项目的视频 ({videos.length}个)</h2>
          <button className={styles.addSubjectBtn} onClick={() => setShowCreate(true)}>+ 添加视频</button>
        </div>

        {showCreate && (
          <div className={styles.createForm}>
            <input
              className={styles.createInput}
              placeholder="视频名称"
              value={newVideoName}
              onChange={e => setNewVideoName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreateVideo()}
              autoFocus
            />
            <button className={styles.createConfirm} onClick={handleCreateVideo} disabled={creating}>
              {creating ? '创建中...' : '创建'}
            </button>
            <button className={styles.createCancel} onClick={() => { setShowCreate(false); setNewVideoName(''); }}>
              取消
            </button>
          </div>
        )}

        {videos.length === 0 ? (
          <div className={styles.empty}>
            <div>还没有视频</div>
            <div className={styles.emptyHint}>点击「添加视频」开始创作</div>
          </div>
      ) : (
        <>
        <div className={styles.videoList}>
          {videos.slice(videoPage * PAGE_SIZE, (videoPage + 1) * PAGE_SIZE).map((video, idx) => {
            const status = STATUS_MAP[video.status] || STATUS_MAP.draft;
            return (
              <div key={video.id} className={styles.videoCard} onClick={() => router.push(`/voiceover-v3?projectId=${projectId}&videoId=${video.id}`)}>
                <span className={styles.indexBadge}>视频{videoPage * PAGE_SIZE + idx + 1}</span>
                <div className={styles.videoInfo}>
                  <div className={styles.videoName}>{video.name}</div>
                  <div className={styles.videoMeta}>
                    <span className={styles.badge} style={{ color: status.color, background: status.bg }}>
                      {status.label}
                    </span>
                    <span>{video.shot_count} 个分镜</span>
                    <span>{video.ratio}</span>
                  </div>
                  {video.script && (
                    <div className={styles.videoScript}>{video.script.slice(0, 80)}{video.script.length > 80 ? '...' : ''}</div>
                  )}
                </div>
                <button className={styles.videoDelete} onClick={e => handleDeleteVideo(e, video.id)} title="删除">
                  ×
                </button>
              </div>
            );
          })}
        </div>
        {videos.length > PAGE_SIZE && (
          <div className={styles.mobilePagination}>
            <button onClick={() => setVideoPage(p => Math.max(0, p - 1))} disabled={videoPage === 0}
              className={`${styles.pageBtn} ${videoPage === 0 ? styles.pageBtnDisabled : ''}`}>上一页</button>
            <span className={styles.pageInfo}>{videoPage + 1} / {Math.ceil(videos.length / PAGE_SIZE)}</span>
            <button onClick={() => setVideoPage(p => Math.min(Math.ceil(videos.length / PAGE_SIZE) - 1, p + 1))} disabled={videoPage >= Math.ceil(videos.length / PAGE_SIZE) - 1}
              className={`${styles.pageBtn} ${videoPage >= Math.ceil(videos.length / PAGE_SIZE) - 1 ? styles.pageBtnDisabled : ''}`}>下一页</button>
          </div>
        )}
        </>
      )}
      </section>
    </div>
    </>
  );
}
