#!/usr/bin/env python3
"""AWSops 2D report-style diagram renderer: Python diagrams (mingrammer) + Graphviz.

Imported from dac-poc (v4, AWS reference-architecture structure — nested clusters
VPC > AZ (dashed blue) > subnet (green/blue bands) > individual resources.
ALBs at VPC level (outside AZ boxes), Internet at top level) and extended with
CLI options so the dashboard /api/diagram route can drive it:
  --data-dir/--outdir/--out-name  path control (route uses a temp dir)
  --exclude-subnets               comma-separated subnet ids or names to drop
Usage: python3 generate_diagrams.py --vpc jaeho.p-vpc [--direction TB|LR]
"""
import json, os, re, argparse, ipaddress
from collections import defaultdict

ap = argparse.ArgumentParser()
ap.add_argument("--vpc", required=True, help="vpc-id or Name tag")
ap.add_argument("--direction", default="TB", choices=["TB", "LR"])
ap.add_argument("--dpi", type=int, default=0, help="override dpi (for previews)")
ap.add_argument("--suffix", default="", help="output filename suffix")
ap.add_argument("--uniform-axis", default="width", choices=["width", "height"],
                dest="axis")
ap.add_argument("--include-empty", action="store_true")
ap.add_argument("--data-dir", default="/home/ec2-user/dac-poc/data")
ap.add_argument("--outdir", default="/home/ec2-user/dac-poc")
ap.add_argument("--out-name", default="", help="output base name (no extension)")
ap.add_argument("--exclude-subnets", default="",
                help="comma-separated subnet ids or names to exclude")
args = ap.parse_args()

DATA = args.data_dir
OUTDIR = args.outdir
EXCLUDE = set(x.strip() for x in args.exclude_subnets.split(",") if x.strip())

def load(name, optional=False):
    p = os.path.join(DATA, name + ".json")
    if optional and not os.path.exists(p):
        return []
    d = json.load(open(p))
    return d["rows"] if isinstance(d, dict) and "rows" in d else d

vpc_subnets = load("vpc_subnets")
ec2s = load("ec2")
elbs = load("elb")
nats = load("nat")
rtbs = load("route_tables")
tg_rows = load("target_groups", optional=True)

vpc_meta = {r["vpc_id"]: r for r in vpc_subnets}
matches = [v for v, m in vpc_meta.items() if args.vpc in (v, m.get("vpc_name"))]
if not matches:
    raise SystemExit("VPC not found: %s" % args.vpc)
VPC = matches[0]
meta = vpc_meta[VPC]
vpc_name = meta.get("vpc_name") or VPC
vpc_cidr = meta.get("vpc_cidr") or ""

def excluded(s):
    return s.get("subnet_id") in EXCLUDE or (s.get("subnet_name") or "") in EXCLUDE

v_ec2 = [r for r in ec2s if r["vpc_id"] == VPC and r.get("instance_state") != "terminated"]
v_elb = [r for r in elbs if r.get("vpc_id") == VPC]
v_nat = [r for r in nats if r["vpc_id"] == VPC]
v_subnets = [s for s in vpc_subnets
             if s["vpc_id"] == VPC and s.get("subnet_id") and not excluded(s)]

# ---- public/private via route tables ----
subnet_rtb, main_rtb = {}, {}
for rt in rtbs:
    for a in (rt.get("associations") or []):
        if a.get("SubnetId"):
            subnet_rtb[a["SubnetId"]] = rt
        if a.get("Main"):
            main_rtb[rt["vpc_id"]] = rt
def is_public(sid, map_public):
    rt = subnet_rtb.get(sid) or main_rtb.get(VPC)
    if rt is not None:
        return any((r.get("GatewayId") or "").startswith("igw-")
                   for r in (rt.get("routes") or []))
    return bool(map_public)

def short_id(rid):
    parts = (rid or "unknown").split("-", 1)
    return parts[0] + "-" + parts[1][:6] if len(parts) == 2 else rid

def title_of(name, rid):
    return name if name else short_id(rid)

def wrap(s, width=14):
    tokens = re.split(r"(?<=[-._/])", s or "")
    out, cur = [], ""
    for t in tokens:
        while len(t) > width:
            if cur:
                out.append(cur); cur = ""
            out.append(t[:width]); t = t[width:]
        if len(cur) + len(t) <= width:
            cur += t
        else:
            out.append(cur); cur = t
    if cur:
        out.append(cur)
    return "\n".join(x for x in out if x)

# fixed type labels for gateways (user decision)
subnet_az = {s["subnet_id"]: s.get("availability_zone") for s in v_subnets}
def az_suffix(az):
    return az.rsplit("-", 1)[-1] if az else "?"
def nat_label(r):
    if len(v_nat) > 1:
        return "NAT GW (%s)" % az_suffix(subnet_az.get(r.get("subnet_id")))
    return "NAT GW"
IGW_LABEL = "IGW"

# ---- subnet grid (AZ x tier), empty/excluded subnets dropped ----
ec2_in_subnet = defaultdict(list)
for r in v_ec2:
    ec2_in_subnet[r["subnet_id"]].append(r)
nat_in_subnet = defaultdict(list)
for r in v_nat:
    nat_in_subnet[r["subnet_id"]].append(r)

grid = defaultdict(lambda: {"public": [], "private": []})
for s in sorted(v_subnets, key=lambda x: (x.get("availability_zone") or "", x["subnet_id"])):
    sid = s["subnet_id"]
    if not ec2_in_subnet.get(sid) and not nat_in_subnet.get(sid) and not args.include_empty:
        continue
    tier = "public" if is_public(sid, s.get("map_public_ip_on_launch")) else "private"
    grid[s.get("availability_zone") or "unknown"][tier].append(s)
azs = sorted(grid.keys())

# ---- one-axis standard (graphviz approximation) ----
# width mode: every subnet row holds up to N_STD icons (pad short rows with
# invisible nodes, wrap extras to next row via invisible edges).
# height mode: columns of up to N_STD icons, width grows with column count.
def _res_count(s):
    sid = s["subnet_id"]
    return len(ec2_in_subnet.get(sid, [])) + len(nat_in_subnet.get(sid, []))
_counts = [_res_count(s) for az in azs for t in ("public", "private") for s in grid[az][t]]
N_STD = max(1, min(max(_counts) if _counts else 1, 3))

INVIS_ATTR = {"shape": "box", "style": "invis", "label": "",
              "width": "1.4", "height": "1.9", "fixedsize": "true"}

def subnet_label(s):
    leaf = (s.get("subnet_name") or s["subnet_id"]).split("/")[-1]
    return "%s (%s)" % (leaf, s.get("subnet_cidr") or "")

# ---- ALB target resolution ----
subnet_cidr_map = {s["subnet_id"]: s["subnet_cidr"] for s in v_subnets if s.get("subnet_cidr")}
inst_ids = set(r["instance_id"] for r in v_ec2)
def subnet_containing(ip):
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return None
    for sid, cidr in subnet_cidr_map.items():
        if a in ipaddress.ip_network(cidr):
            return sid
    return None
tg_by_lb = defaultdict(list)
for r in tg_rows:
    for lb in (r.get("load_balancer_arns") or []):
        tg_by_lb[lb].append(r)
def resolve_targets(arn):
    out = set()
    for tg in tg_by_lb.get(arn, []):
        for thd in (tg.get("target_health_descriptions") or []):
            tid = (thd.get("Target") or {}).get("Id") or ""
            if tid.startswith("i-"):
                if tid in inst_ids:
                    out.add(tid)
            else:
                sid = subnet_containing(tid)
                if sid:
                    cands = ec2_in_subnet.get(sid, [])
                    eks_c = [c for c in cands if re.search(r"eks|worker|node", c.get("name") or "", re.I)]
                    for c in (eks_c or cands):
                        out.add(c["instance_id"])
    return out

# ---- draw ----
from diagrams import Diagram, Cluster, Edge, Node
from diagrams.aws.compute import EC2
from diagrams.aws.network import ALB, NATGateway
from diagrams.onprem.network import Internet

base_name = args.out_name or ("awsops-%s-diagrams%s"
                              % (re.sub(r"[^A-Za-z0-9._-]+", "-", vpc_name), args.suffix))
base = os.path.join(OUTDIR, base_name)
graph_attr = {"fontsize": "20", "bgcolor": "white", "pad": "0.5",
              "nodesep": "0.8", "ranksep": "1.0"}
if args.dpi:
    graph_attr["dpi"] = str(args.dpi)

VPC_ATTR = {"style": "solid", "bgcolor": "#faf9ff", "color": "#8C4FFF",
            "fontcolor": "#5A2CA0", "margin": "24", "penwidth": "2"}
AZ_ATTR = {"style": "dashed", "bgcolor": "white", "color": "#147EBA",
           "fontcolor": "#147EBA", "margin": "20"}
PUB_ATTR = {"style": "solid", "bgcolor": "#e9f3e6", "color": "#7AA116",
            "fontcolor": "#3F6212", "margin": "18"}
PRV_ATTR = {"style": "solid", "bgcolor": "#e6f2f8", "color": "#127EBA",
            "fontcolor": "#0B4F71", "margin": "18"}

edge_count = 0
seen_pairs = set()
def draw(a, b, edge=None):
    global edge_count
    key = (id(a), id(b))
    if key in seen_pairs:
        return
    seen_pairs.add(key)
    if edge is not None:
        a >> edge >> b
    else:
        a >> b
    edge_count += 1

with Diagram("AWSops - %s (%s)" % (vpc_name, vpc_cidr),
             filename=base, outformat="png", show=False,
             direction=args.direction, graph_attr=graph_attr):
    internet = Internet("Internet")
    node_by_arn, node_by_instance, nat_nodes = {}, {}, []
    with Cluster("%s (%s)" % (vpc_name, vpc_cidr), graph_attr=VPC_ATTR):
        # ALBs at VPC level (outside AZ boxes)
        for e in sorted(v_elb, key=lambda r: r["elb_name"]):
            node_by_arn[e["arn"]] = ALB(wrap(e["elb_name"]))
        for az in azs:
            with Cluster("Availability Zone %s" % az, graph_attr=AZ_ATTR):
                for tier, attr in (("public", PUB_ATTR), ("private", PRV_ATTR)):
                    for s in grid[az][tier]:
                        sid = s["subnet_id"]
                        with Cluster(subnet_label(s), graph_attr=attr):
                            cell_nodes = []
                            for x in nat_in_subnet.get(sid, []):
                                n_ = NATGateway(nat_label(x))
                                nat_nodes.append(n_)
                                cell_nodes.append(n_)
                            for x in sorted(ec2_in_subnet.get(sid, []),
                                            key=lambda r: r["instance_id"]):
                                n_ = EC2(wrap(title_of(x.get("name"), x["instance_id"])))
                                node_by_instance[x["instance_id"]] = n_
                                cell_nodes.append(n_)
                            # pad up to one standard row/column with invisible nodes
                            while len(cell_nodes) < N_STD:
                                cell_nodes.append(Node(**INVIS_ATTR))
                            if args.axis == "width":
                                # wrap: row k feeds row k+1 (invisible ranking edges)
                                for k in range(len(cell_nodes) - N_STD):
                                    cell_nodes[k] >> Edge(style="invis") >> cell_nodes[k + N_STD]
                            else:
                                # columns of N_STD: chain nodes within each column
                                for k in range(len(cell_nodes) - 1):
                                    if (k + 1) % N_STD != 0:
                                        cell_nodes[k] >> Edge(style="invis") >> cell_nodes[k + 1]

    for e in sorted(v_elb, key=lambda r: r["elb_name"]):
        n = node_by_arn.get(e["arn"])
        if n is None:
            continue
        if e.get("scheme") == "internet-facing":
            draw(internet, n, Edge(label="HTTPS"))
        for inst in sorted(resolve_targets(e["arn"])):
            if inst in node_by_instance:
                draw(n, node_by_instance[inst])
    if nat_nodes:
        nat0 = nat_nodes[0]
        for inst_node in {id(v): v for v in node_by_instance.values()}.values():
            draw(inst_node, nat0, Edge(style="dashed"))
        draw(nat0, internet, Edge(style="dashed"))

print("PNG written:", base + ".png")
print("AZs:", azs, "| subnets drawn:",
      sum(len(grid[a][t]) for a in azs for t in ("public", "private")),
      "| EC2:", len(v_ec2), "| ALB:", len(v_elb), "| NAT:", len(v_nat),
      "| edges:", edge_count)
